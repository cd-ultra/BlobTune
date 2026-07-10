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
    const minFreq = opts.minFreq || 65;   // ~C2
    const maxFreq = opts.maxFreq || 1200; // ~D6
    const clarityFloor = opts.clarityFloor != null ? opts.clarityFloor : 0.85;

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

    return {
      times, freqs, clarities,
      hopSeconds: hopSize / sampleRate,
      frameSeconds: frameSize / sampleRate,
    };
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
    freqToMidi,
    midiToFreq,
    midiToName,
    isBlackKey,
    NOTE_NAMES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
