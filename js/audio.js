/*
 * audio.js — playback engine with pitch editing.
 *
 * Holds the decoded (mono) signal, renders an edited version of it where every
 * note whose pitchOffset != 0 is pitch-shifted by the corresponding ratio, and
 * plays that back through the Web Audio API with a tracked playhead.
 *
 * Pitch shifting preserves note duration using OLA time-stretch followed by a
 * linear-interpolation resample (a simple, classic, dependency-free approach).
 * Quality is modest — this is an educational clone, not a production DSP core.
 */
(function (global) {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.sampleRate = 44100;
      this.dry = null;        // Float32Array — original mono signal
      this.notes = [];
      this.source = null;
      this.editedBuffer = null;
      this.dirty = true;
      this.isPlaying = false;
      this.startCtxTime = 0;  // ctx.currentTime when playback started
      this.startOffset = 0;   // seconds into the track at play start
      this.duration = 0;
      this.onEnded = null;
      // Lock the source formant envelope onto pitch-shifted notes (keeps vocal
      // timbre; avoids the chipmunk/dark colour of large shifts). Toggleable.
      this.preserveFormants = true;
    }

    /** Enable/disable formant preservation on pitch shifts; forces a re-render. */
    setPreserveFormants(on) {
      const v = !!on;
      if (v !== this.preserveFormants) { this.preserveFormants = v; this.dirty = true; }
    }

    _ensureCtx() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    /** Load from a decoded AudioBuffer (mono-summed). */
    loadAudioBuffer(audioBuffer) {
      this.sampleRate = audioBuffer.sampleRate;
      const len = audioBuffer.length;
      const mono = new Float32Array(len);
      const chs = audioBuffer.numberOfChannels;
      for (let c = 0; c < chs; c++) {
        const d = audioBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += d[i] / chs;
      }
      this.dry = mono;
      this.duration = len / this.sampleRate;
      this.dirty = true;
    }

    /** Load directly from a Float32Array (used by the built-in demo). */
    loadSamples(samples, sampleRate) {
      this.dry = samples;
      this.sampleRate = sampleRate;
      this.duration = samples.length / sampleRate;
      this.dirty = true;
    }

    setNotes(notes) { this.notes = notes; }
    markDirty() { this.dirty = true; }

    /**
     * Decode an ArrayBuffer of encoded audio using the engine's own
     * AudioContext. Reusing the single long-lived context (instead of spinning
     * up a throwaway one per decode) avoids leaking AudioContexts — browsers
     * such as Chrome hard-cap the number of live contexts (~6) and then throw
     * on `new AudioContext()`, which previously broke loading/recording after a
     * few uses. Returns a Promise<AudioBuffer>.
     */
    decode(arrayBuffer) {
      const ctx = this._ensureCtx();
      // decodeAudioData detaches its input; hand it a copy so callers keep theirs.
      return ctx.decodeAudioData(arrayBuffer.slice(0));
    }

    getMono() { return this.dry; }

    /**
     * Return the edited mono signal (with all pitch edits applied) as a
     * Float32Array, rendering it first if the edits have changed. Used by the
     * WAV exporter so the file matches exactly what playback produces.
     */
    getEditedSamples() {
      if (this.dirty || !this.editedBuffer) this._renderEdited();
      return this.editedBuffer.getChannelData(0);
    }

    // Notes sorted by their source-audio start (the order they appear in dry).
    _sortedNotes() {
      return this.notes.slice().sort((a, b) => a.srcStart - b.srcStart);
    }

    // Target output length (samples) of a note given its source length.
    _noteTargetLen(srcLen, stretch) {
      return Math.max(1, Math.round(srcLen * (stretch > 0 ? stretch : 1)));
    }

    /**
     * Recompute every note's edited startTime/endTime and the total edited
     * duration by walking the notes in time order — for each note, advancing by
     * its (stretched) target length, and keeping the inter-note gap audio
     * unchanged. Cheap (no DSP): used during a length drag to reposition blobs
     * and follow the growing/shrinking timeline. `_renderEdited()` performs the
     * exact same walk in samples, so blob positions stay consistent with audio.
     */
    layout() {
      const sr = this.sampleRate;
      const dryLen = this.dry ? this.dry.length : 0;
      let cursor = 0;   // edited sample position
      let dryPos = 0;   // dry sample position consumed so far
      for (const n of this._sortedNotes()) {
        const ns0 = clampInt(Math.floor(n.srcStart * sr), 0, dryLen);
        const ns1 = clampInt(Math.floor(n.srcEnd * sr), 0, dryLen);
        cursor += Math.max(0, ns0 - dryPos);          // inter-note gap (unchanged)
        const srcLen = Math.max(0, ns1 - ns0);
        const targetLen = this._noteTargetLen(srcLen, n.stretch);
        n.startTime = cursor / sr;
        n.endTime = (cursor + targetLen) / sr;
        cursor += targetLen;
        dryPos = ns1;
      }
      cursor += Math.max(0, dryLen - dryPos);          // trailing audio
      this.duration = cursor / sr;
      return this.duration;
    }

    /**
     * Build the edited buffer by walking the notes in time order: copy the dry
     * gap audio before each note unchanged, then emit the note's audio pitch-
     * shifted (length-preserving) and time-stretched to its target duration, then
     * copy the trailing audio. This grows/shrinks the total timeline, so it also
     * writes back each note's edited startTime/endTime and the new duration.
     */
    _renderEdited() {
      const sr = this.sampleRate;
      const dry = this.dry;
      const dryLen = dry.length;
      const parts = [];
      let dryPos = 0;
      let cursor = 0;
      for (const n of this._sortedNotes()) {
        const ns0 = clampInt(Math.floor(n.srcStart * sr), 0, dryLen);
        const ns1 = clampInt(Math.floor(n.srcEnd * sr), 0, dryLen);
        if (ns0 > dryPos) { parts.push(dry.subarray(dryPos, ns0)); cursor += ns0 - dryPos; }
        dryPos = Math.max(dryPos, ns1);
        const srcLen = Math.max(0, ns1 - ns0);
        if (srcLen <= 0) { n.startTime = cursor / sr; n.endTime = cursor / sr; continue; }

        let seg = dry.slice(ns0, ns1);
        // Pitch shift (preserves length) using the note's detected fundamental.
        if (n.pitchOffset && srcLen >= 64) {
          const ratio = Math.pow(2, n.pitchOffset / 12);
          const freq = global.Pitch.midiToFreq(n.detectedMidi);
          seg = pitchShift(seg, ratio, sr, freq, this.preserveFormants);
        }
        // Time-stretch to the note's target duration (changes the timeline).
        // `seg` is now at the EDITED pitch, so drive the pitch-synchronous
        // stretch with the edited fundamental for clean, non-robotic sustain.
        const targetLen = this._noteTargetLen(srcLen, n.stretch);
        if (targetLen !== seg.length) seg = stretchTo(seg, targetLen, sr, global.Pitch.midiToFreq(n.midi));
        // Short fades at the seams so concatenation doesn't click.
        edgeFade(seg, Math.min(64, Math.floor(seg.length / 8)));

        n.startTime = cursor / sr;
        n.endTime = (cursor + seg.length) / sr;
        parts.push(seg);
        cursor += seg.length;
      }
      if (dryLen > dryPos) { parts.push(dry.subarray(dryPos, dryLen)); cursor += dryLen - dryPos; }

      const out = new Float32Array(cursor);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }

      this.duration = out.length / sr;
      const ctx = this._ensureCtx();
      const buf = ctx.createBuffer(1, out.length || 1, sr);
      buf.copyToChannel(out, 0);
      this.editedBuffer = buf;
      this.dirty = false;
    }

    play(fromTime) {
      const ctx = this._ensureCtx();
      if (this.isPlaying) this._stopSource();
      if (this.dirty || !this.editedBuffer) this._renderEdited();

      const offset = fromTime != null ? fromTime : this.startOffset;
      const src = ctx.createBufferSource();
      src.buffer = this.editedBuffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (this.source === src) {
          this.isPlaying = false;
          this.source = null;
          if (this.onEnded) this.onEnded();
        }
      };
      src.start(0, Math.max(0, Math.min(offset, this.duration - 0.001)));
      this.source = src;
      this.isPlaying = true;
      this.startCtxTime = ctx.currentTime;
      this.startOffset = offset;
    }

    pause() {
      if (!this.isPlaying) return;
      this.startOffset = this.getCurrentTime();
      this._stopSource();
    }

    stop() {
      this._stopSource();
      this.startOffset = 0;
    }

    _stopSource() {
      if (this.source) {
        try { this.source.onended = null; this.source.stop(); } catch (_) {}
        this.source = null;
      }
      this.isPlaying = false;
    }

    seek(t) {
      const was = this.isPlaying;
      this.startOffset = Math.max(0, Math.min(t, this.duration));
      if (was) this.play(this.startOffset);
    }

    getCurrentTime() {
      if (!this.isPlaying || !this.ctx) return this.startOffset;
      const t = this.startOffset + (this.ctx.currentTime - this.startCtxTime);
      return Math.min(t, this.duration);
    }

    /**
     * Audition a single pitch: play a short synthesized note at the given MIDI
     * value (used by the click-to-play piano keyboard). Independent of the loaded
     * track, so it works even before any audio is loaded.
     */
    previewMidi(midi, dur) {
      const ctx = this._ensureCtx();
      dur = dur || 0.5;
      const freq = global.Pitch.midiToFreq(midi);
      const now = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.22, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0006, now + dur);
      g.connect(ctx.destination);
      // A sine plus a softer octave-ish partial for a warmer, piano-ish timbre.
      const partials = [[1, 1], [2, 0.28], [3, 0.12]];
      for (const [mult, amp] of partials) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        const pg = ctx.createGain();
        pg.gain.value = amp;
        osc.connect(pg); pg.connect(g);
        osc.start(now); osc.stop(now + dur + 0.02);
      }
    }
  }

  // ---- DSP: TD-PSOLA pitch shifter (with OLA fallback) ----

  /**
   * Pitch-shift `segment` by `ratio`, preserving duration, using TD-PSOLA
   * (time-domain pitch-synchronous overlap-add). Because the material is
   * monophonic and we know the note's fundamental, we lay pitch-synchronous
   * Hann grains at the input period and re-space them at period/ratio — this
   * changes pitch without the phasey warble of generic fixed-hop OLA.
   *
   * Grains are placed at synthesis marks spaced by P/ratio; each pulls the
   * analysis grain nearest the SAME time (identity time-map => duration kept).
   * The window half-width is max(P, synthesis spacing) so grains always keep
   * >=50% overlap (no amplitude dips), even for downward shifts.
   *
   * The synthesis spacing is accumulated as a FLOAT (P/ratio), not rounded to an
   * integer number of samples. Integer rounding would collapse to zero shift for
   * fine (few-cent) ratios — e.g. at 264 Hz a +5-cent ratio moves the period by
   * only ~0.5 sample, which rounds away. Keeping the spacing fractional makes
   * sub-semitone (cents) edits shift pitch by the correct amount on average.
   */
  function psolaShift(segment, sampleRate, freq, ratio) {
    const P = Math.round(sampleRate / freq);           // analysis period (samples)
    const Psf = P / ratio;                             // synthesis period (float)
    const halfW = Math.max(P, Math.ceil(Psf));
    const win = hann(2 * halfW);
    const n = segment.length;
    const out = new Float32Array(n);
    const norm = new Float32Array(n);

    for (let sf = 0; sf < n; sf += Psf) {
      const s = Math.round(sf);
      // Nearest analysis pitch-mark to this synthesis position (identity time).
      const a = Math.round(s / P) * P;
      for (let k = -halfW; k < halfW; k++) {
        const ai = a + k;
        const si = s + k;
        if (ai < 0 || ai >= n || si < 0 || si >= n) continue;
        const w = win[k + halfW];
        out[si] += segment[ai] * w;
        norm[si] += w;
      }
    }
    for (let i = 0; i < n; i++) {
      out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : segment[i];
    }
    return out;
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  // ---- Formant (spectral-envelope) preservation ----

  /**
   * Re-impose the SOURCE segment's formant envelope onto a pitch-shifted signal.
   *
   * TD-PSOLA already keeps formants roughly in place (that's its edge over plain
   * resampling), but on large shifts the residual drift is audible — up-shifts
   * brighten toward "chipmunk", down-shifts darken — and the OLA/resample
   * fallback shifts formants outright. This stage locks the timbre: for each
   * short STFT frame (source and shifted are the same length, so they line up in
   * time) it estimates the smooth spectral envelope of both via low-quefrency
   * cepstral liftering, then scales the shifted spectrum bin-by-bin by
   *
   *     gain(f) = envSource(f) / envShifted(f)
   *
   * and overlap-adds the result. The lifter cutoff sits BELOW the pitch period,
   * so each envelope captures formants but not the harmonic fine structure —
   * the gain is therefore smooth in frequency and moves formants back to where
   * the source had them WITHOUT disturbing the (already shifted) pitch. When the
   * shifter preserved the envelope well, envShifted ≈ envSource and the gain is
   * ≈1 (a near no-op), so this only corrects real drift.
   *
   * Cepstral envelope: E(f) = exp(lifter{ real-cepstrum{ log|X(f)| } }), where
   * the lifter keeps only quefrencies below the fundamental period P.
   */
  function preserveFormants(shifted, source, sampleRate, freq) {
    const P = Math.max(1, Math.round(sampleRate / freq));
    // FFT frame: a power of two spanning several periods for a stable envelope.
    let frame = 512;
    while (frame < 4 * P) frame <<= 1;
    if (frame > 4096) frame = 4096;
    const n = shifted.length;
    if (n < frame) return shifted;               // too short to estimate an envelope

    const hop = frame >> 2;                       // 75% overlap
    const win = hann(frame);
    // Lifter cutoff (quefrency, in samples): below the pitch period so we keep
    // the formant envelope but drop the pitch rahmonic. Clamped to a sane band.
    const lifter = Math.min((frame >> 1) - 1, Math.max(16, Math.round(P * 0.5)));
    const GMIN = 0.25, GMAX = 4;                   // clamp correction to ±12 dB

    const out = new Float32Array(n);
    const norm = new Float32Array(n);

    // Reused per-frame scratch.
    const Hre = new Float64Array(frame), Him = new Float64Array(frame);
    const Sre = new Float64Array(frame), Sim = new Float64Array(frame);
    const cr = new Float64Array(frame), ci = new Float64Array(frame);
    const envS = new Float64Array(frame), envH = new Float64Array(frame);

    // Smooth magnitude envelope of the spectrum (re,im), written into `env`.
    // Uses cr/ci as scratch; leaves re/im untouched.
    const envelope = (re, im, env) => {
      for (let k = 0; k < frame; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        cr[k] = Math.log(mag + 1e-8);
        ci[k] = 0;
      }
      global.FFT.inverse(cr, ci);                 // real cepstrum in cr
      for (let q = lifter + 1; q < frame - lifter; q++) cr[q] = 0;  // keep low quefrency
      for (let q = 0; q < frame; q++) ci[q] = 0;
      global.FFT.transform(cr, ci);               // back to smoothed log-magnitude
      for (let k = 0; k < frame; k++) env[k] = Math.exp(cr[k]);
    };

    for (let pos = 0; pos + frame <= n; pos += hop) {
      for (let i = 0; i < frame; i++) {
        const w = win[i];
        Sre[i] = source[pos + i] * w; Sim[i] = 0;
        Hre[i] = shifted[pos + i] * w; Him[i] = 0;
      }
      global.FFT.transform(Sre, Sim);
      global.FFT.transform(Hre, Him);
      envelope(Sre, Sim, envS);
      envelope(Hre, Him, envH);
      // Scale the shifted spectrum toward the source envelope (real gain keeps
      // the spectrum conjugate-symmetric, so the inverse stays real).
      for (let k = 0; k < frame; k++) {
        let g = envS[k] / (envH[k] + 1e-8);
        if (g < GMIN) g = GMIN; else if (g > GMAX) g = GMAX;
        Hre[k] *= g; Him[k] *= g;
      }
      global.FFT.inverse(Hre, Him);               // back to time domain (real in Hre)
      for (let i = 0; i < frame; i++) {
        const w = win[i];
        out[pos + i] += Hre[i] * w;
        norm[pos + i] += w * w;
      }
    }
    // Weighted-overlap-add normalize; keep the raw shifted signal at the
    // uncovered head/tail so edges never drop out.
    for (let i = 0; i < n; i++) {
      out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : shifted[i];
    }
    return out;
  }

  /**
   * Time-stretch a signal by `factor` (output length ≈ input.length * factor)
   * using fixed-hop overlap-add with a Hann window. Pitch is preserved.
   */
  function timeStretch(input, factor) {
    const frame = 1024;
    const synHop = Math.floor(frame / 4);      // 256
    const anaHop = Math.max(1, synHop / factor);
    const win = hann(frame);
    const outLen = Math.max(frame, Math.ceil(input.length * factor) + frame);
    const out = new Float32Array(outLen);
    const norm = new Float32Array(outLen);

    let anaPos = 0;
    let synPos = 0;
    while (anaPos + frame < input.length) {
      const base = Math.floor(anaPos);
      for (let i = 0; i < frame; i++) {
        const s = input[base + i] * win[i];
        out[synPos + i] += s;
        norm[synPos + i] += win[i];
      }
      anaPos += anaHop;
      synPos += synHop;
    }
    for (let i = 0; i < outLen; i++) {
      if (norm[i] > 1e-6) out[i] /= norm[i];
    }
    return out.subarray(0, Math.max(frame, Math.round(input.length * factor)));
  }

  function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Apply a short linear fade-in and fade-out (in place) to soften seams. */
  function edgeFade(buf, fade) {
    if (!fade || fade < 1) return buf;
    const n = buf.length;
    for (let i = 0; i < fade && i < n; i++) {
      const g = i / fade;
      buf[i] *= g;
      buf[n - 1 - i] *= g;
    }
    return buf;
  }

  /**
   * Pitch-synchronous time-stretch (TD-PSOLA) to an exact target length,
   * preserving pitch. Because we know the note's fundamental, we lay Hann grains
   * two periods long at synthesis marks spaced ONE period apart (so the output
   * keeps the same period → same pitch), and for each synthesis mark pull the
   * analysis grain from the mapped input time (synthesisTime / factor) snapped to
   * the nearest pitch mark. Repeating/omitting whole pitch periods this way keeps
   * every grain phase-aligned, which avoids the "robotic"/phasey warble that
   * fixed-hop OLA produces on voiced material.
   */
  function psolaStretch(segment, sampleRate, freq, targetLen) {
    const inLen = segment.length;
    const P = Math.round(sampleRate / freq);
    const factor = targetLen / inLen;
    const win = hann(2 * P);
    const out = new Float32Array(targetLen);
    const norm = new Float32Array(targetLen);
    for (let s = 0; s < targetLen; s += P) {
      // Map this output position back to input time, snap to a whole period.
      const a = Math.round((s / factor) / P) * P;
      for (let k = -P; k < P; k++) {
        const ai = a + k, si = s + k;
        if (ai < 0 || ai >= inLen || si < 0 || si >= targetLen) continue;
        const w = win[k + P];
        out[si] += segment[ai] * w;
        norm[si] += w;
      }
    }
    for (let i = 0; i < targetLen; i++) out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
    return out;
  }

  /**
   * Time-stretch `input` to an exact target sample length, preserving pitch.
   * Uses pitch-synchronous PSOLA when a usable fundamental is known (clean on
   * voiced/monophonic material); otherwise falls back to fixed-hop OLA + a tiny
   * resample, and to a plain resample for very short inputs.
   */
  /**
   * End (sample index) of a note's onset transient: the first short-time energy
   * peak within the opening ~60 ms. Copying up to here verbatim keeps a hard
   * attack sharp instead of smearing it across a long stretch.
   */
  function attackEnd(seg, sampleRate) {
    const win = Math.max(4, Math.round(0.004 * sampleRate));   // 4 ms energy window
    const maxSearch = Math.min(seg.length, Math.round(0.06 * sampleRate));
    if (maxSearch < win + 2) return 0;
    let e = 0;
    for (let i = 0; i < win; i++) e += seg[i] * seg[i];
    let peak = e, peakIdx = win;
    for (let i = win; i < maxSearch; i++) {
      e += seg[i] * seg[i] - seg[i - win] * seg[i - win];
      if (e > peak) { peak = e; peakIdx = i; }
    }
    return peakIdx;
  }

  function stretchTo(input, targetLen, sampleRate, freq) {
    if (targetLen === input.length) return Float32Array.from(input);
    const P = freq > 0 ? Math.round(sampleRate / freq) : 0;
    if (P >= 4 && input.length >= 2 * P && targetLen >= 2 * P) {
      // Transient-aware: on a LENGTHENING stretch, copy the onset attack
      // verbatim and stretch only the sustain after it, so a hard attack stays
      // sharp. (Compression and attack-less notes just use plain PSOLA.)
      if (targetLen > input.length) {
        const aEnd = Math.min(attackEnd(input, sampleRate), Math.round(0.05 * sampleRate));
        const sustainLen = input.length - aEnd;
        const sustainTarget = targetLen - aEnd;
        // Copy the (possibly short) attack verbatim as long as the sustain is
        // long enough to PSOLA-stretch. A sharp attack is only a few ms, so we
        // must NOT require it to be multiple periods long.
        if (aEnd > 0 && sustainLen >= 2 * P && sustainTarget >= 2 * P) {
          const st = psolaStretch(input.subarray(aEnd), sampleRate, freq, sustainTarget);
          const out = new Float32Array(targetLen);
          out.set(input.subarray(0, aEnd), 0);
          out.set(st, aEnd);
          // Short crossfade from the real post-attack signal into the stretched
          // sustain so the attack→sustain seam has no phase click.
          const cf = Math.min(P, sustainLen - 1, 128);
          for (let i = 0; i < cf; i++) {
            const g = i / cf;
            out[aEnd + i] = input[aEnd + i] * (1 - g) + st[i] * g;
          }
          return out;
        }
      }
      return psolaStretch(input, sampleRate, freq, targetLen);
    }
    if (targetLen < 2 || input.length < 1024) return resampleTo(input, targetLen);
    const factor = targetLen / input.length;
    const stretched = timeStretch(input, factor);
    if (stretched.length === targetLen) return Float32Array.from(stretched);
    return resampleTo(stretched, targetLen);
  }

  /** Linear-interpolation resample to an exact target length. */
  function resampleTo(input, targetLen) {
    const out = new Float32Array(targetLen);
    const scale = (input.length - 1) / (targetLen - 1 || 1);
    for (let i = 0; i < targetLen; i++) {
      const pos = i * scale;
      const i0 = Math.floor(pos);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  /**
   * Pitch-shift by `ratio` (e.g. 2^(semitones/12)) preserving duration.
   * Uses TD-PSOLA when a usable fundamental is known (clean, monophonic);
   * otherwise falls back to OLA time-stretch + resample. When `formants` is set
   * (and a fundamental is known), the source's spectral envelope is locked onto
   * the result so the vocal timbre is kept even on large shifts.
   */
  function pitchShift(segment, ratio, sampleRate, freq, formants) {
    if (Math.abs(ratio - 1) < 1e-4) return Float32Array.from(segment);
    const P = freq > 0 ? Math.round(sampleRate / freq) : 0;
    // PSOLA needs at least a couple of periods of context inside the segment.
    if (P >= 4 && segment.length >= 4 * P) {
      const shifted = psolaShift(segment, sampleRate, freq, ratio);
      return formants ? preserveFormants(shifted, segment, sampleRate, freq) : shifted;
    }
    const stretched = timeStretch(segment, ratio);
    return resampleTo(stretched, segment.length);
  }

  /**
   * Encode a mono Float32Array as a 16-bit PCM WAV file and return a Blob.
   * Samples are clamped to [-1, 1] to avoid wrap-around on any overshoot from
   * the crossfades/resampling. Dependency-free; produces a standard RIFF/WAVE
   * that any DAW or player can open.
   */
  function encodeWavPCM16(samples, sampleRate) {
    const numFrames = samples.length;
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;      // mono
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);           // fmt chunk size
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // channels = mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);           // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      let s = samples[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  global.AudioEngine = AudioEngine;
  global.DSP = { timeStretch, stretchTo, psolaStretch, resampleTo, pitchShift, psolaShift, preserveFormants, encodeWavPCM16 };
})(typeof window !== 'undefined' ? window : globalThis);
