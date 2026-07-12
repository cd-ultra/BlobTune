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
    // A held sung note wobbles (vibrato, typ. ±0.4–0.7 st). We only split when
    // the SMOOTHED pitch settles more than this far from the note's robust
    // centre, so a wobble no longer shatters one note into many blobs.
    const semitoneTolerance = opts.semitoneTolerance || 1.1;
    const maxGapFrames = opts.maxGapFrames || 2;        // bridge short unvoiced gaps
    const smoothRadius = opts.smoothRadius != null ? opts.smoothRadius : 2; // median-filter half-width
    // A departure from the centre must persist this many frames before it counts
    // as a real note change (hysteresis) — a single vibrato peak snaps back and
    // is reabsorbed rather than starting a new blob.
    const splitPersist = opts.splitPersist != null ? opts.splitPersist : 3;
    // Trailing window (in frames) over which the note's centre pitch is taken as
    // a median — robust to vibrato and to a biased first frame.
    const centerWindow = opts.centerWindow || 16;
    // Onset (re-articulation) splitting: a same-pitch note that is re-attacked
    // without a silent gap shows a clear ENERGY dip-then-rise. We split there so
    // two struck notes at one pitch become two blobs, while sustained/vibrato
    // notes (whose amplitude only wobbles gently) do not.
    const onsetSplit = opts.onsetSplit !== false;

    const { times, freqs, rms } = track;
    const onsets = onsetSplit && rms ? detectOnsets(rms, opts) : null;
    // How far to grow each blob past its outermost frame centre so it covers the
    // whole region the pitch is sounding (frames "hear" ~half a window each way).
    const pad = (track.frameSeconds || (track.hopSeconds || 0.011) * 4) / 2;
    const rawMidis = freqs.map((f) => (f > 0 ? global.Pitch.freqToMidi(f) : null));
    // Split decisions run on a median-smoothed pitch so per-frame jitter and lone
    // outliers don't trigger spurious boundaries; the note's reported pitch is
    // still the median of the RAW frames (see buildNote), so accuracy is kept.
    const midis = medianSmooth(rawMidis, smoothRadius);

    const notes = [];
    let cur = null;       // {frames:[{i,t,midi,raw}], pending:[{...}]}
    let gap = 0;

    // Robust centre of the current note: median of the last `centerWindow`
    // committed smoothed pitches.
    const centerOf = (frames) => {
      const from = Math.max(0, frames.length - centerWindow);
      const w = [];
      for (let k = from; k < frames.length; k++) w.push(frames[k].midi);
      w.sort((a, b) => a - b);
      return w[Math.floor(w.length / 2)];
    };

    const flush = () => {
      if (cur) {
        // Drop a trailing run of pending (deviating) frames that never reached
        // the persistence threshold — they belong to no committed note.
        if (cur.frames.length >= minNoteFrames) notes.push(buildNote(cur.frames, pad));
      }
      cur = null;
    };

    for (let i = 0; i < midis.length; i++) {
      const m = midis[i];
      const raw = rawMidis[i];
      if (m == null) {
        if (cur) {
          gap++;
          if (gap > maxGapFrames) flush();
        }
        continue;
      }
      gap = 0;
      const frame = { i, t: times[i], midi: m, raw: raw != null ? raw : m };
      if (!cur) {
        cur = { frames: [frame], pending: [] };
        continue;
      }
      const center = centerOf(cur.frames);
      if (Math.abs(m - center) > semitoneTolerance) {
        // Departure: hold it aside until we know if it persists.
        cur.pending.push(frame);
        if (cur.pending.length >= splitPersist) {
          // Sustained change → the pending frames start a new note.
          const pend = cur.pending;
          cur.pending = [];
          flush();
          cur = { frames: pend.slice(), pending: [] };
        }
      } else if (onsets && onsets[i] && cur.frames.length >= minNoteFrames) {
        // Same pitch, but a clear re-articulation onset lands here: end the
        // current blob and start a fresh one at the attack.
        if (cur.pending.length) { cur.frames.push(...cur.pending); cur.pending = []; }
        flush();
        cur = { frames: [frame], pending: [] };
      } else {
        // Back within tolerance — reabsorb any pending wobble frames.
        if (cur.pending.length) { cur.frames.push(...cur.pending); cur.pending = []; }
        cur.frames.push(frame);
      }
    }
    // Any unresolved pending frames were a brief wobble at the tail; keep them.
    if (cur && cur.pending.length) { cur.frames.push(...cur.pending); cur.pending = []; }
    flush();

    // Keep adjacent blobs from overlapping after padding: where two notes would
    // collide, meet them at the midpoint.
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].startTime < notes[i - 1].endTime) {
        const mid = (notes[i].startTime + notes[i - 1].endTime) / 2;
        notes[i - 1].endTime = mid;
        notes[i].startTime = mid;
      }
    }

    return notes;
  }

  function buildNote(frames, pad) {
    pad = pad || 0;
    const startTime = Math.max(0, frames[0].t - pad);
    const endTime = frames[frames.length - 1].t + pad;
    // Report the RAW-pitch median (unbiased by smoothing) as the note pitch.
    const sorted = frames.map((f) => (f.raw != null ? f.raw : f.midi)).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const curve = frames.map((f) => ({ t: f.t, midi: f.raw != null ? f.raw : f.midi }));
    return new Note(startTime, endTime, median, curve);
  }

  /**
   * Median-smooth an array of values that may contain nulls (unvoiced frames).
   * Nulls stay null; each voiced value becomes the median of the voiced values
   * within `radius` frames. Removes single-frame jitter/outliers while
   * preserving edges better than a mean filter. radius 0 → identity.
   */
  function medianSmooth(arr, radius) {
    if (!radius) return arr.slice();
    const n = arr.length;
    const out = new Array(n);
    const w = [];
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) { out[i] = null; continue; }
      w.length = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
        if (arr[j] != null) w.push(arr[j]);
      }
      w.sort((a, b) => a - b);
      out[i] = w[Math.floor(w.length / 2)];
    }
    return out;
  }

  /**
   * Detect re-articulation onsets from a per-frame (normalized) RMS envelope.
   *
   * A struck/re-attacked note at the same pitch produces a local energy DIP
   * (the singer briefly backs off / a soft consonant) followed by a clear RISE.
   * We look for local minima whose trough sits well below the surrounding level
   * (`dipRatio`) and that recover by at least `riseRatio`, and place the onset at
   * the frame where the envelope climbs back through that recovery level.
   *
   * Gentle vibrato/tremolo amplitude wobble (typically <20%) fails BOTH the dip
   * and the rise test, so a sustained note is not chopped up. A minimum gap
   * between onsets further guards against periodic wobble firing repeatedly.
   *
   * @returns {boolean[]} onset[i] true where a new articulation begins.
   */
  function detectOnsets(rms, opts) {
    opts = opts || {};
    const dipRatio = opts.onsetDipRatio != null ? opts.onsetDipRatio : 0.6;   // trough <= dipRatio*peak
    const riseRatio = opts.onsetRiseRatio != null ? opts.onsetRiseRatio : 1.5; // recover to riseRatio*trough
    const win = opts.onsetWindow || 8;         // frames to look back/ahead for peak & recovery
    const minGap = opts.onsetMinGapFrames || 6; // min frames between onsets
    const minLevel = opts.onsetMinLevel != null ? opts.onsetMinLevel : 0.06; // ignore near-silence
    const n = rms.length;
    const onsets = new Array(n).fill(false);
    if (n < 5) return onsets;

    // Light 3-point smoothing so single-frame ripples don't read as troughs.
    const env = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) { s += rms[j]; c++; }
      env[i] = s / c;
    }

    let lastOnset = -minGap - 1;
    for (let i = 2; i < n - 2; i++) {
      // Local minimum (trough) of the smoothed envelope.
      if (!(env[i] <= env[i - 1] && env[i] < env[i + 1])) continue;
      const trough = env[i];
      // Peak just before the dip.
      let leftMax = 0;
      for (let j = Math.max(0, i - win); j < i; j++) if (env[j] > leftMax) leftMax = env[j];
      if (leftMax < minLevel) continue;
      if (trough > dipRatio * leftMax) continue; // not a real dip
      // Recovery: find where the envelope climbs back to riseRatio*trough.
      const target = Math.max(riseRatio * trough, minLevel);
      let onsetIdx = -1;
      for (let j = i + 1; j <= Math.min(n - 1, i + win); j++) {
        if (env[j] >= target && env[j] > trough) { onsetIdx = j; break; }
      }
      if (onsetIdx < 0) continue;
      if (onsetIdx - lastOnset < minGap) continue;
      onsets[onsetIdx] = true;
      lastOnset = onsetIdx;
    }
    return onsets;
  }

  /**
   * Snap a raw midi value to the nearest semitone integer.
   */
  function snapMidi(midi) { return Math.round(midi); }

  global.Notes = { Note, segmentNotes, snapMidi, detectOnsets };
})(typeof window !== 'undefined' ? window : globalThis);
