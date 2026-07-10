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

    /** Build the edited buffer by pitch-shifting each edited note in place. */
    _renderEdited() {
      const out = this.dry.slice(0);
      const sr = this.sampleRate;
      for (const n of this.notes) {
        if (!n.pitchOffset) continue;
        const s0 = Math.max(0, Math.floor(n.startTime * sr));
        const s1 = Math.min(this.dry.length, Math.ceil(n.endTime * sr));
        if (s1 - s0 < 64) continue;
        const seg = this.dry.subarray(s0, s1);
        const ratio = Math.pow(2, n.pitchOffset / 12);
        const shifted = pitchShift(seg, ratio);
        // Equal-power-ish crossfade at the boundaries to hide seams.
        const fade = Math.min(256, Math.floor((s1 - s0) / 8));
        for (let i = 0; i < shifted.length; i++) {
          let g = 1;
          if (i < fade) g = i / fade;
          else if (i > shifted.length - fade) g = Math.max(0, (shifted.length - i) / fade);
          const idx = s0 + i;
          out[idx] = shifted[i] * g + out[idx] * (1 - g);
        }
      }
      const ctx = this._ensureCtx();
      const buf = ctx.createBuffer(1, out.length, sr);
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
  }

  // ---- DSP: OLA time-stretch + resample pitch shifter ----

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
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
   * Stretch by ratio, then resample back to the original length.
   */
  function pitchShift(segment, ratio) {
    if (Math.abs(ratio - 1) < 1e-4) return Float32Array.from(segment);
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
  global.DSP = { timeStretch, resampleTo, pitchShift, encodeWavPCM16 };
})(typeof window !== 'undefined' ? window : globalThis);
