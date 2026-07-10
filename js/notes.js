/*
 * notes.js — the "blob" model.
 *
 * Takes the per-frame pitch track from pitch.js and groups consecutive voiced
 * frames of similar pitch into Note objects (the draggable "blobs"). Each Note
 * stores its detected pitch plus a user pitch offset (in semitones) so edits
 * are non-destructive and can be reset.
 */
(function (global) {
  'use strict';

  let _id = 1;

  /**
   * A single detected note / blob.
   */
  class Note {
    constructor(startTime, endTime, detectedMidi, curve) {
      this.id = _id++;
      this.startTime = startTime;       // seconds
      this.endTime = endTime;           // seconds
      this.detectedMidi = detectedMidi; // float midi (median of frames)
      this.pitchOffset = 0;             // user edit, in semitones (snapped)
      this.selected = false;
      // curve: array of {t, midi} sampled points across the note (detected)
      this.curve = curve || [];
    }
    get duration() { return this.endTime - this.startTime; }
    // Effective (edited) pitch in midi.
    get midi() { return this.detectedMidi + this.pitchOffset; }
    get name() { return global.Pitch.midiToName(this.midi); }
  }

  /**
   * Segment a pitch track into notes.
   * @param {{times:number[],freqs:number[],clarities:number[],hopSeconds:number}} track
   * @param {object} [opts]
   * @returns {Note[]}
   */
  function segmentNotes(track, opts) {
    opts = opts || {};
    const minNoteFrames = opts.minNoteFrames || 4;      // ignore tiny blips
    const semitoneTolerance = opts.semitoneTolerance || 0.75; // split if pitch jumps
    const maxGapFrames = opts.maxGapFrames || 2;        // bridge short unvoiced gaps

    const { times, freqs } = track;
    const midis = freqs.map((f) => (f > 0 ? global.Pitch.freqToMidi(f) : null));

    const notes = [];
    let cur = null;       // {frames:[{i,t,midi}]}
    let gap = 0;

    const flush = () => {
      if (cur && cur.frames.length >= minNoteFrames) {
        notes.push(buildNote(cur.frames));
      }
      cur = null;
    };

    for (let i = 0; i < midis.length; i++) {
      const m = midis[i];
      if (m == null) {
        if (cur) {
          gap++;
          if (gap > maxGapFrames) flush();
        }
        continue;
      }
      gap = 0;
      if (!cur) {
        cur = { frames: [{ i, t: times[i], midi: m }], running: m };
      } else {
        // Split when pitch moves away from the running average by > tolerance.
        if (Math.abs(m - cur.running) > semitoneTolerance) {
          flush();
          cur = { frames: [{ i, t: times[i], midi: m }], running: m };
        } else {
          cur.frames.push({ i, t: times[i], midi: m });
          const n = cur.frames.length;
          cur.running = (cur.running * (n - 1) + m) / n; // incremental mean
        }
      }
    }
    flush();

    return notes;
  }

  function buildNote(frames) {
    const startTime = frames[0].t;
    const hop = frames.length > 1 ? frames[1].t - frames[0].t : 0.011;
    const endTime = frames[frames.length - 1].t + hop;
    const sorted = frames.map((f) => f.midi).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const curve = frames.map((f) => ({ t: f.t, midi: f.midi }));
    return new Note(startTime, endTime, median, curve);
  }

  /**
   * Snap a raw midi value to the nearest semitone integer.
   */
  function snapMidi(midi) { return Math.round(midi); }

  global.Notes = { Note, segmentNotes, snapMidi };
})(typeof window !== 'undefined' ? window : globalThis);
