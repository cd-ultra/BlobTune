/*
 * midi.js — a tiny Standard MIDI File (SMF) reader/writer.
 *
 * export: encodeMidiFromNotes(notes) -> Blob
 *   Writes a format-0 SMF where each note becomes a note-on/note-off pair at
 *   its EDITED pitch (detectedMidi + pitchOffset, rounded), timed from the
 *   note's start/end seconds at a fixed 120 BPM.
 *
 * import: parseMidi(arrayBuffer) -> [{startTime, endTime, midi}]
 *   Parses format-0 and format-1 files: merges all tracks onto one timeline,
 *   follows tempo (set-tempo) changes, honors running status, and pairs
 *   note-ons with their note-offs (note-on velocity 0 counts as an off).
 *
 * Dependency-free; educational scope (no SMPTE division, no per-channel
 * separation — everything is flattened to a single monophonic-ish blob list).
 */
(function (global) {
  'use strict';

  const PPQ = 480;                 // ticks per quarter note (export)
  const DEFAULT_TEMPO = 500000;    // microseconds per quarter (120 BPM)
  const EXPORT_BPM = 120;

  // ---------- writing ----------

  function writeVarLen(bytes, value) {
    let buffer = value & 0x7f;
    while ((value >>= 7)) {
      buffer <<= 8;
      buffer |= (value & 0x7f) | 0x80;
    }
    while (true) {
      bytes.push(buffer & 0xff);
      if (buffer & 0x80) buffer >>= 8;
      else break;
    }
  }

  function pushU32(bytes, v) { bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
  function pushStr(bytes, s) { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); }

  function encodeMidiFromNotes(notes) {
    const secondsPerQuarter = 60 / EXPORT_BPM;
    const ticksPerSecond = PPQ / secondsPerQuarter;

    // Build absolute-tick events, then sort and delta-encode.
    const events = [];
    for (const n of notes) {
      const midi = clampMidi(Math.round(n.detectedMidi + (n.pitchOffset || 0)));
      const onTick = Math.max(0, Math.round(n.startTime * ticksPerSecond));
      let offTick = Math.round(n.endTime * ticksPerSecond);
      if (offTick <= onTick) offTick = onTick + 1;
      events.push({ tick: onTick, order: 1, kind: 'on', midi });
      events.push({ tick: offTick, order: 0, kind: 'off', midi });
    }
    // Sort by tick; at the same tick, note-offs before note-ons (order asc).
    events.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));

    const track = [];
    // Tempo meta at t=0.
    writeVarLen(track, 0);
    track.push(0xff, 0x51, 0x03,
      (DEFAULT_TEMPO >> 16) & 0xff, (DEFAULT_TEMPO >> 8) & 0xff, DEFAULT_TEMPO & 0xff);

    let prevTick = 0;
    for (const e of events) {
      writeVarLen(track, e.tick - prevTick);
      prevTick = e.tick;
      if (e.kind === 'on') track.push(0x90, e.midi, 80);
      else track.push(0x80, e.midi, 0);
    }
    // End of track.
    writeVarLen(track, 0);
    track.push(0xff, 0x2f, 0x00);

    const out = [];
    pushStr(out, 'MThd');
    pushU32(out, 6);
    out.push(0x00, 0x00);          // format 0
    out.push(0x00, 0x01);          // one track
    out.push((PPQ >> 8) & 0xff, PPQ & 0xff);
    pushStr(out, 'MTrk');
    pushU32(out, track.length);
    for (let i = 0; i < track.length; i++) out.push(track[i]);

    return new Blob([new Uint8Array(out)], { type: 'audio/midi' });
  }

  // ---------- reading ----------

  function parseMidi(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    let pos = 0;
    const readStr = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(pos++)); return s; };

    if (readStr(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd).');
    const headerLen = dv.getUint32(pos); pos += 4;
    /* const format = */ dv.getUint16(pos); pos += 2;
    const ntrks = dv.getUint16(pos); pos += 2;
    const division = dv.getInt16(pos); pos += 2;
    pos += headerLen - 6; // skip any extra header bytes
    if (division <= 0) throw new Error('SMPTE time division is not supported.');

    // Pass 1: collect raw events (absolute ticks) across all tracks.
    const rawNotes = [];     // {tick, kind, midi}
    const tempos = [];       // {tick, usPerQuarter}

    for (let t = 0; t < ntrks; t++) {
      if (readStr(4) !== 'MTrk') break;
      const trackLen = dv.getUint32(pos); pos += 4;
      const end = pos + trackLen;
      let tick = 0;
      let running = 0;

      while (pos < end) {
        tick += readVarLen(dv, () => pos, (p) => { pos = p; });
        let status = dv.getUint8(pos);
        if (status & 0x80) { pos++; running = status; }
        else { status = running; }           // running status: reuse last

        if (status === 0xff) {               // meta
          const type = dv.getUint8(pos++);
          const len = readVarLen(dv, () => pos, (p) => { pos = p; });
          if (type === 0x51 && len === 3) {
            const us = (dv.getUint8(pos) << 16) | (dv.getUint8(pos + 1) << 8) | dv.getUint8(pos + 2);
            tempos.push({ tick, usPerQuarter: us });
          }
          pos += len;
        } else if (status === 0xf0 || status === 0xf7) { // sysex
          const len = readVarLen(dv, () => pos, (p) => { pos = p; });
          pos += len;
        } else {
          const hi = status & 0xf0;
          const d1 = dv.getUint8(pos++);
          let d2 = 0;
          if (hi !== 0xc0 && hi !== 0xd0) d2 = dv.getUint8(pos++); // 2-data-byte messages
          if (hi === 0x90 && d2 > 0) rawNotes.push({ tick, kind: 'on', midi: d1 });
          else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) rawNotes.push({ tick, kind: 'off', midi: d1 });
        }
      }
      pos = end;
    }

    // Build a tempo map -> convert ticks to seconds.
    tempos.sort((a, b) => a.tick - b.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerQuarter: DEFAULT_TEMPO });
    const tickToSec = makeTickToSec(tempos, division);

    // Pair note-ons with note-offs (FIFO per pitch).
    rawNotes.sort((a, b) => (a.tick - b.tick) || (a.kind === 'off' ? -1 : 1));
    const open = new Map(); // midi -> [startTick,...]
    const notes = [];
    for (const e of rawNotes) {
      if (e.kind === 'on') {
        if (!open.has(e.midi)) open.set(e.midi, []);
        open.get(e.midi).push(e.tick);
      } else {
        const stack = open.get(e.midi);
        if (stack && stack.length) {
          const startTick = stack.shift();
          notes.push({ startTime: tickToSec(startTick), endTime: tickToSec(e.tick), midi: e.midi });
        }
      }
    }
    notes.sort((a, b) => a.startTime - b.startTime);
    return notes;
  }

  function readVarLen(dv, getPos, setPos) {
    let p = getPos();
    let value = 0;
    let byte;
    do {
      byte = dv.getUint8(p++);
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    setPos(p);
    return value;
  }

  function makeTickToSec(tempos, division) {
    // Precompute cumulative seconds at each tempo change boundary.
    const segs = tempos.map((t) => ({ tick: t.tick, spt: (t.usPerQuarter / 1e6) / division }));
    const cum = [0];
    for (let i = 1; i < segs.length; i++) {
      cum[i] = cum[i - 1] + (segs[i].tick - segs[i - 1].tick) * segs[i - 1].spt;
    }
    return function (tick) {
      let i = segs.length - 1;
      while (i > 0 && segs[i].tick > tick) i--;
      return cum[i] + (tick - segs[i].tick) * segs[i].spt;
    };
  }

  function clampMidi(m) { return m < 0 ? 0 : m > 127 ? 127 : m; }

  global.MIDI = { encodeMidiFromNotes, parseMidi };
})(typeof window !== 'undefined' ? window : globalThis);
