/*
 * pitch.js — monophonic pitch detection.
 *
 * Implements the YIN algorithm (de Cheveigné & Kawahara, 2002) over short
 * overlapping frames, producing a per-frame pitch track (frequency + a
 * confidence/clarity value). This track is later segmented into note "blobs"
 * by notes.js.
 *
 * Everything here is plain, dependency-free JavaScript that runs on a
 * Float32Array of mono samples.
 */
(function (global) {
  'use strict';

  /**
   * Estimate the fundamental frequency of a single frame using YIN.
   * @param {Float32Array} frame  windowed slice of samples
   * @param {number} sampleRate
   * @param {number} threshold    YIN absolute threshold (typ. 0.10–0.15)
   * @returns {{freq:number, clarity:number}} freq=-1 when unvoiced
   */
  function yinFrame(frame, sampleRate, threshold) {
    const size = frame.length;
    const halfSize = Math.floor(size / 2);
    const diff = new Float32Array(halfSize);

    // Step 1: difference function d(tau)
    for (let tau = 1; tau < halfSize; tau++) {
      let sum = 0;
      for (let i = 0; i < halfSize; i++) {
        const delta = frame[i] - frame[i + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    // Step 2: cumulative mean normalized difference d'(tau)
    const cmnd = new Float32Array(halfSize);
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfSize; tau++) {
      runningSum += diff[tau];
      cmnd[tau] = runningSum === 0 ? 1 : (diff[tau] * tau) / runningSum;
    }

    // Step 3: absolute threshold — first dip below threshold
    let tauEstimate = -1;
    for (let tau = 2; tau < halfSize; tau++) {
      if (cmnd[tau] < threshold) {
        // walk to the local minimum of this dip
        while (tau + 1 < halfSize && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate === -1) return { freq: -1, clarity: 0 };

    // Step 4: parabolic interpolation around the minimum for sub-sample tau
    const x0 = tauEstimate > 0 ? tauEstimate - 1 : tauEstimate;
    const x2 = tauEstimate + 1 < halfSize ? tauEstimate + 1 : tauEstimate;
    let betterTau = tauEstimate;
    if (x0 !== tauEstimate && x2 !== tauEstimate) {
      const s0 = cmnd[x0], s1 = cmnd[tauEstimate], s2 = cmnd[x2];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / denom;
    }

    const freq = sampleRate / betterTau;
    const clarity = 1 - cmnd[tauEstimate]; // higher = more periodic
    return { freq, clarity };
  }

  /**
   * Run YIN across the whole signal.
   * @param {Float32Array} samples  mono signal
   * @param {number} sampleRate
   * @param {object} [opts]
   * @returns {{times:number[], freqs:number[], clarities:number[], hopSeconds:number}}
   */
  function detectPitchTrack(samples, sampleRate, opts) {
    opts = opts || {};
    const frameSize = opts.frameSize || 2048;
    const hopSize = opts.hopSize || 512;
    const threshold = opts.threshold || 0.12;
    // Default range tuned for the singing voice (~E2..B5). YIN on voice
    // occasionally reports an octave error; keeping the ceiling below ~1kHz and
    // the floor near typical vocal range reduces spurious out-of-range picks,
    // and octaveCorrect() (below) repairs the transient ones that slip through.
    const minFreq = opts.minFreq || 80;   // ~E2
    const maxFreq = opts.maxFreq || 1000; // ~B5
    const clarityFloor = opts.clarityFloor != null ? opts.clarityFloor : 0.85;
    const postProcess = opts.postProcess !== false; // octave-jump correction

    const times = [];
    const freqs = [];
    const clarities = [];
    const window = hannWindow(frameSize);
    const frame = new Float32Array(frameSize);

    // RMS for a rough silence gate, normalized to the loudest frame.
    let peakRms = 1e-9;
    const rmsVals = [];
    for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
      let sum = 0;
      for (let i = 0; i < frameSize; i++) {
        const s = samples[start + i];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / frameSize);
      rmsVals.push(rms);
      if (rms > peakRms) peakRms = rms;
    }
    const silenceGate = peakRms * 0.04;

    let idx = 0;
    for (let start = 0; start + frameSize <= samples.length; start += hopSize, idx++) {
      // Time-stamp each estimate at the CENTRE of its analysis window, not the
      // start — otherwise every note reads ~half a frame late and its blob is
      // shifted/short relative to where the pitch is actually sounding.
      const t = (start + frameSize / 2) / sampleRate;
      if (rmsVals[idx] < silenceGate) {
        times.push(t); freqs.push(-1); clarities.push(0);
        continue;
      }
      for (let i = 0; i < frameSize; i++) frame[i] = samples[start + i] * window[i];
      const { freq, clarity } = yinFrame(frame, sampleRate, threshold);
      const voiced = freq >= minFreq && freq <= maxFreq && clarity >= clarityFloor;
      times.push(t);
      freqs.push(voiced ? freq : -1);
      clarities.push(voiced ? clarity : 0);
    }

    if (postProcess) octaveCorrect(freqs, opts.octaveRadius || 4);

    return {
      times, freqs, clarities,
      hopSeconds: hopSize / sampleRate,
      frameSeconds: frameSize / sampleRate,
    };
  }

  /**
   * Repair transient octave/harmonic jumps in a per-frame frequency track.
   *
   * YIN on a real voice sometimes latches onto twice or half the true period for
   * a few frames (breathy onsets, formant emphasis), which reads as a sudden
   * ±12-semitone leap and then a jump back. For each voiced frame we take the
   * MEDIAN pitch of its voiced neighbours (robust to those outliers) and, if
   * shifting the frame by ±1 octave moves it strictly closer to that median,
   * snap it there. A genuinely sustained octave change is NOT undone, because
   * once enough frames sit at the new octave the local median follows them.
   * On clean tones every frame already equals its neighbours' median, so this is
   * a no-op and clean-tone behaviour is unchanged.
   *
   * Mutates `freqs` in place.
   */
  function octaveCorrect(freqs, radius) {
    const n = freqs.length;
    const midis = new Array(n);
    for (let i = 0; i < n; i++) midis[i] = freqs[i] > 0 ? freqToMidi(freqs[i]) : null;
    const corrected = midis.slice();
    const win = [];
    for (let i = 0; i < n; i++) {
      if (midis[i] == null) continue;
      win.length = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
        if (midis[j] != null) win.push(midis[j]);
      }
      if (win.length < 3) continue; // not enough context to judge
      win.sort((a, b) => a - b);
      const med = win[Math.floor(win.length / 2)];
      let bestShift = 0;
      let bestDist = Math.abs(midis[i] - med);
      for (const k of [-1, 1]) {
        const d = Math.abs(midis[i] + 12 * k - med);
        if (d < bestDist - 1e-6) { bestDist = d; bestShift = k; } // strict improvement only
      }
      if (bestShift !== 0) corrected[i] = midis[i] + 12 * bestShift;
    }
    for (let i = 0; i < n; i++) {
      if (corrected[i] != null && corrected[i] !== midis[i]) freqs[i] = midiToFreq(corrected[i]);
    }
  }

  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  // ---- Musical helpers (shared across modules) ----
  const A4 = 440;
  const A4_MIDI = 69;

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / A4);
  }
  function midiToFreq(midi) {
    return A4 * Math.pow(2, (midi - A4_MIDI) / 12);
  }
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiToName(midi) {
    const m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }
  function isBlackKey(midi) {
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    return [1, 3, 6, 8, 10].indexOf(pc) !== -1;
  }

  global.Pitch = {
    detectPitchTrack,
    yinFrame,
    octaveCorrect,
    freqToMidi,
    midiToFreq,
    midiToName,
    isBlackKey,
    NOTE_NAMES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
