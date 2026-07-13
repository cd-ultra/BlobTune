/*
 * onset.js — spectral-flux note-onset detection.
 *
 * Reimplements the well-known spectral-flux onset technique (as used by aubio
 * and countless MIR papers) in plain JS on top of our own FFT — GPL-free, no
 * dependencies. For each STFT hop we sum the positive (increasing) magnitude
 * changes across bins; a note attack injects broadband energy and spikes the
 * flux, even when there's NO amplitude dip before it (a legato re-articulation
 * of the same pitch), which the previous energy dip-then-rise cue missed.
 *
 * Frames use the same size/hop as pitch detection and are centre-timestamped,
 * so onset frame indices line up 1:1 with the pitch track.
 */
(function (global) {
  'use strict';

  /**
   * @param {Float32Array} samples  mono signal
   * @param {number} sampleRate
   * @param {object} [opts]
   * @returns {{times:number[], flux:number[], onsets:number[], hopSeconds:number}}
   *   `onsets` is a list of frame indices at detected onsets.
   */
  function detect(samples, sampleRate, opts) {
    opts = opts || {};
    const frameSize = opts.frameSize || 2048;
    const hopSize = opts.hopSize || 512;
    const half = frameSize >> 1;
    const win = hann(frameSize);
    const re = new Float64Array(frameSize);
    const im = new Float64Array(frameSize);
    let prev = new Float32Array(half);
    let cur = new Float32Array(half);

    const flux = [];
    const times = [];
    let first = true;
    for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
      for (let i = 0; i < frameSize; i++) { re[i] = samples[start + i] * win[i]; im[i] = 0; }
      global.FFT.transform(re, im);
      let f = 0;
      for (let k = 0; k < half; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        cur[k] = mag;
        const d = mag - prev[k];
        if (d > 0) f += d;                 // half-wave rectify: only increases count as onsets
      }
      flux.push(first ? 0 : f);
      times.push((start + frameSize / 2) / sampleRate);
      const tmp = prev; prev = cur; cur = tmp; // swap buffers
      first = false;
    }

    return {
      times, flux,
      onsets: pickPeaks(flux, opts),
      hopSeconds: hopSize / sampleRate,
    };
  }

  /**
   * Adaptive-threshold peak picking on the flux curve: a frame is an onset when
   * it is a local maximum, exceeds a local-mean threshold, and is at least
   * `minOnsetGapFrames` after the previous onset (debounce).
   */
  function pickPeaks(flux, opts) {
    const n = flux.length;
    const w = opts.thresholdWindow || 8;                       // ± frames for the local mean
    const mult = opts.thresholdMult != null ? opts.thresholdMult : 1.6;
    const minGap = opts.minOnsetGapFrames || 4;                // ~46 ms at 512/44.1k
    // A floor relative to the whole clip so quiet ripples never register.
    let mx = 0; for (let i = 0; i < n; i++) if (flux[i] > mx) mx = flux[i];
    const floor = mx * (opts.fluxFloor != null ? opts.fluxFloor : 0.08);

    const onsets = [];
    let last = -1e9;
    for (let i = 1; i < n - 1; i++) {
      if (!(flux[i] > flux[i - 1] && flux[i] >= flux[i + 1])) continue; // local max
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { sum += flux[j]; cnt++; }
      const thr = (sum / cnt) * mult;
      if (flux[i] >= thr && flux[i] >= floor && i - last >= minGap) {
        onsets.push(i);
        last = i;
      }
    }
    return onsets;
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  global.Onset = { detect };
})(typeof window !== 'undefined' ? window : globalThis);
