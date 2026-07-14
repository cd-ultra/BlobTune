/*
 * spectrogram.js — an STFT magnitude spectrogram, computed on our own FFT.
 *
 * Produces the data the renderer paints UNDER the note blobs so you can see the
 * harmonics, vibrato and noise that the pitch track was distilled from (and
 * eyeball/verify the detection). Dependency-free, static-site friendly: it just
 * runs a windowed FFT per hop and stores per-bin magnitudes in decibels.
 *
 * `compute(samples, sampleRate, opts)` returns:
 *   { mags:Float32Array (frameCount*nBins, dB), frameCount, nBins, binHz,
 *     hopSeconds, frameSeconds, maxDb, floorDb }
 * `mags` is row-major by frame: bin k of frame f is mags[f*nBins + k].
 */
(function (global) {
  'use strict';

  function compute(samples, sampleRate, opts) {
    opts = opts || {};
    // Larger frame than pitch/onset: better low-frequency resolution so bass
    // notes still land on distinct semitone rows in the pitch-axis view.
    const frameSize = opts.frameSize || 4096;
    const hopSize = opts.hopSize || 1024;
    const nBins = frameSize >> 1;
    const binHz = sampleRate / frameSize;
    const win = hann(frameSize);
    const re = new Float64Array(frameSize);
    const im = new Float64Array(frameSize);

    const len = samples ? samples.length : 0;
    const frameCount = len >= frameSize ? 1 + Math.floor((len - frameSize) / hopSize) : 0;
    const mags = new Float32Array(frameCount * nBins);

    let maxDb = -Infinity;
    let f = 0;
    for (let start = 0; start + frameSize <= len; start += hopSize, f++) {
      for (let i = 0; i < frameSize; i++) { re[i] = samples[start + i] * win[i]; im[i] = 0; }
      global.FFT.transform(re, im);
      const base = f * nBins;
      for (let k = 0; k < nBins; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const db = 20 * Math.log10(mag + 1e-9);
        mags[base + k] = db;
        if (db > maxDb) maxDb = db;
      }
    }
    if (!isFinite(maxDb)) maxDb = 0;

    return {
      mags, frameCount, nBins, binHz,
      hopSeconds: hopSize / sampleRate,
      frameSeconds: frameSize / sampleRate,
      maxDb,
      floorDb: maxDb - (opts.dynamicRangeDb || 80),   // dB below peak → transparent
    };
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  global.Spectrogram = { compute };
})(typeof window !== 'undefined' ? window : globalThis);
