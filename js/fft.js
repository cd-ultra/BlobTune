/*
 * fft.js — a tiny, dependency-free radix-2 Cooley–Tukey FFT.
 *
 * Hand-written (no libraries, no build step) so BlobTune can do spectral
 * analysis — spectral-flux onset detection today, and a spectrogram / any
 * polyphony work later — while staying a plain static site.
 *
 * `transform(re, im)` does an in-place complex FFT; length must be a power of
 * two. `magnitude(frame, out)` returns the magnitude spectrum (first N/2 bins)
 * of a real frame. Callers that run it per-hop should reuse buffers via
 * `transform` directly to avoid per-frame allocation.
 */
(function (global) {
  'use strict';

  /**
   * In-place iterative radix-2 FFT. `re` and `im` are equal-length typed arrays
   * (Float32Array/Float64Array) whose length is a power of two; `im` is all-zero
   * for real input. Overwrites both with the transform.
   */
  function transform(re, im) {
    const n = re.length;
    if (n <= 1) return;

    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    // Danielson–Lanczos butterflies.
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;                 // running twiddle
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cwr - im[b] * cwi;
          const xi = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr;        im[a] += xi;
          const ncwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = ncwr;
        }
      }
    }
  }

  /**
   * In-place inverse FFT. `re`/`im` are the transform of a length-N (power of
   * two) sequence; on return they hold the reconstructed samples, scaled by 1/N
   * so that inverse(transform(x)) === x. Implemented via the standard
   * conjugate → forward → conjugate/scale identity, so it reuses `transform`.
   * Used by the cepstral formant-envelope estimator in audio.js.
   */
  function inverse(re, im) {
    const n = re.length;
    if (n <= 1) return;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    transform(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }

  /**
   * Magnitude spectrum (bins 0..N/2-1) of a real frame of power-of-two length.
   * Allocates scratch each call — for hot loops use `transform` with reused
   * buffers instead. `out` is optional (reused if provided).
   */
  function magnitude(frame, out) {
    const n = frame.length;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = frame[i];
    transform(re, im);
    const half = n >> 1;
    out = out || new Float32Array(half);
    for (let k = 0; k < half; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return out;
  }

  global.FFT = { transform, inverse, magnitude };
})(typeof window !== 'undefined' ? window : globalThis);
