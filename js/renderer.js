/*
 * renderer.js — the piano-roll blob editor.
 *
 * Owns the canvas, the view transform (zoom + scroll), all drawing (keyboard,
 * time ruler, grid, note blobs, pitch curves, playhead) and pointer
 * interaction (select + vertical drag to change pitch, snapped to semitones).
 *
 * It calls back to the host app via the callbacks passed to the constructor,
 * and reads the shared note list it is given. It does not know about audio.
 */
(function (global) {
  'use strict';

  const KEYBOARD_W = 62;   // px, left keyboard gutter
  const RULER_H = 28;      // px, top time ruler
  const SEMITONE_H = 15;   // base px per semitone (scaled by zoomY)
  const PX_PER_SEC = 120;  // base px per second (scaled by zoomX)

  // Fixed addressable pitch range: C0 (MIDI 12) at the bottom to C6 (MIDI 84)
  // at the top. The visible window scrolls (Shift+wheel) within these bounds.
  const MIN_MIDI = 12;     // C0
  const MAX_MIDI = 84;     // C6

  class Renderer {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cb = callbacks || {};

      this.notes = [];
      this.duration = 0;

      // View state
      this.zoomX = 1;
      this.zoomY = 1;
      this.scrollX = 0;              // seconds at left edge of grid
      // topMidi is the (float) MIDI pitch shown at the very top of the grid;
      // the visible window extends downward from it by gridH/semitoneH rows.
      // It is always kept within [MIN_MIDI, MAX_MIDI] by _clampScroll().
      this.topMidi = MAX_MIDI;
      this.playheadTime = 0;

      // Interaction state
      this.drag = null;
      this.flashKey = null;          // MIDI of the momentarily-highlighted key
      this._flashTimer = null;
      this.dpr = Math.max(1, global.devicePixelRatio || 1);

      this._bindEvents();
      this.resize();
    }

    setNotes(notes, duration) {
      this.notes = notes;
      this.duration = duration || this.duration;
      this._fitPitchRange();
      this.scrollX = 0;
      this.render();
    }

    setPlayhead(t) {
      this.playheadTime = t;
      this.render();
    }

    // Choose a default vertical scroll position centered on the detected notes
    // (or on the C3–C4 area when there are none), clamped to the C0–C6 bounds.
    _fitPitchRange() {
      const vis = this.visibleSemis;
      let center;
      if (this.notes.length) {
        let lo = Infinity, hi = -Infinity;
        for (const n of this.notes) {
          lo = Math.min(lo, n.detectedMidi);
          hi = Math.max(hi, n.detectedMidi);
        }
        center = (lo + hi) / 2;
      } else {
        center = 54; // midway between C3 (48) and C4 (60)
      }
      this.topMidi = center + vis / 2;
      this._clampScroll();
    }

    // ---- geometry ----
    get gridW() { return this.canvas.clientWidth - KEYBOARD_W; }
    get gridH() { return this.canvas.clientHeight - RULER_H; }
    get pxPerSec() { return PX_PER_SEC * this.zoomX; }
    get semitoneH() { return SEMITONE_H * this.zoomY; }
    // Number of semitone rows that fit in the visible grid height.
    get visibleSemis() { return this.gridH / this.semitoneH; }

    timeToX(t) { return KEYBOARD_W + (t - this.scrollX) * this.pxPerSec; }
    xToTime(x) { return this.scrollX + (x - KEYBOARD_W) / this.pxPerSec; }
    midiToY(midi) { return RULER_H + (this.topMidi - midi) * this.semitoneH; }
    yToMidi(y) { return this.topMidi - (y - RULER_H) / this.semitoneH; }

    // Keep the visible window within [MIN_MIDI, MAX_MIDI]. If the window is
    // taller than the whole range, center the range vertically.
    _clampScroll() {
      const range = MAX_MIDI - MIN_MIDI;
      const vis = this.visibleSemis;
      if (vis >= range) {
        this.topMidi = MAX_MIDI + (vis - range) / 2;
      } else {
        this.topMidi = clamp(this.topMidi, MIN_MIDI + vis, MAX_MIDI);
      }
    }

    // Inclusive integer MIDI range currently visible, clamped to the bounds.
    get visibleMidiLo() {
      return Math.max(MIN_MIDI, Math.floor(this.topMidi - this.visibleSemis));
    }
    get visibleMidiHi() {
      return Math.min(MAX_MIDI, Math.ceil(this.topMidi));
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = Math.max(1, global.devicePixelRatio || 1);
      this.canvas.width = Math.round(rect.width * this.dpr);
      this.canvas.height = Math.round(rect.height * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._clampScroll();
      this.render();
    }

    zoom(factor, axis) {
      if (axis === 'y') this.zoomY = clamp(this.zoomY * factor, 0.5, 3);
      else this.zoomX = clamp(this.zoomX * factor, 0.25, 8);
      this._clampScroll();
      this.render();
    }

    // ---- drawing ----
    render() {
      const ctx = this.ctx;
      const W = this.canvas.clientWidth;
      const H = this.canvas.clientHeight;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = css('--panel', '#1c2129');
      ctx.fillRect(0, 0, W, H);

      this._drawRows();
      this._drawBeatGrid();
      this._drawNotes();
      this._drawPlayhead();
      this._drawKeyboard();
      this._drawRuler();
      // Mask the top-left corner where ruler meets keyboard.
      ctx.fillStyle = css('--panel-2', '#232a34');
      ctx.fillRect(0, 0, KEYBOARD_W, RULER_H);
      ctx.strokeStyle = css('--edge', '#2e3743');
      ctx.strokeRect(0.5, 0.5, KEYBOARD_W, RULER_H);
    }

    _drawRows() {
      const ctx = this.ctx;
      const W = this.canvas.clientWidth;
      const topM = this.visibleMidiHi;
      const botM = this.visibleMidiLo;
      for (let m = botM; m <= topM; m++) {
        const y = this.midiToY(m);
        if (global.Pitch.isBlackKey(m)) {
          ctx.fillStyle = 'rgba(0,0,0,0.16)';
          ctx.fillRect(KEYBOARD_W, y - this.semitoneH, W - KEYBOARD_W, this.semitoneH);
        }
        // C rows get a stronger separator line.
        const isC = ((m % 12) + 12) % 12 === 0;
        ctx.strokeStyle = isC ? css('--grid-line-strong', '#313b48') : css('--grid-line', '#262d37');
        ctx.beginPath();
        ctx.moveTo(KEYBOARD_W, y + 0.5);
        ctx.lineTo(W, y + 0.5);
        ctx.stroke();
      }
    }

    _drawBeatGrid() {
      const ctx = this.ctx;
      const H = this.canvas.clientHeight;
      // Choose a nice time step so gridlines aren't too dense.
      const targetPx = 90;
      const rawStep = targetPx / this.pxPerSec;
      const step = niceTimeStep(rawStep);
      const first = Math.ceil(this.scrollX / step) * step;
      const end = this.xToTime(this.canvas.clientWidth);
      ctx.strokeStyle = css('--grid-line-strong', '#313b48');
      ctx.lineWidth = 1;
      for (let t = first; t <= end; t += step) {
        const x = this.timeToX(t);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
      }
    }

    _drawNotes() {
      const ctx = this.ctx;
      for (const n of this.notes) {
        const x = this.timeToX(n.startTime);
        const w = Math.max(3, n.duration * this.pxPerSec);
        const midi = n.midi;
        const yCenter = this.midiToY(midi) - this.semitoneH / 2;
        const h = this.semitoneH * 0.82;
        const y = yCenter - h / 2;
        if (x + w < KEYBOARD_W || x > this.canvas.clientWidth) continue;

        // Blob body
        const sel = n.selected;
        ctx.fillStyle = sel ? css('--blob-sel', '#ffd089') : css('--blob', '#f0a04b');
        ctx.strokeStyle = sel ? '#fff2d6' : '#c97f2f';
        ctx.lineWidth = sel ? 2 : 1;
        roundRect(ctx, x, y, w, h, Math.min(6, h / 2));
        ctx.fill();
        ctx.stroke();

        // Detected-pitch curve inside/over the blob (relative to edited pitch).
        if (n.curve && n.curve.length > 1) {
          ctx.strokeStyle = 'rgba(30,20,10,0.55)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let i = 0; i < n.curve.length; i++) {
            const p = n.curve[i];
            const cx = this.timeToX(p.t);
            // curve drawn relative to the note's edited pitch
            const cMidi = p.midi + n.pitchOffset;
            const cy = this.midiToY(cMidi) - this.semitoneH / 2;
            if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
          }
          ctx.stroke();
        }

        // Note name label if there's room.
        if (w > 26 && h > 10) {
          ctx.fillStyle = 'rgba(26,18,6,0.85)';
          ctx.font = '10px -apple-system, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          const label = n.name + (n.pitchOffset ? (n.pitchOffset > 0 ? ' ▲' : ' ▼') : '');
          ctx.fillText(label, x + 4, yCenter);
        }
      }
    }

    _drawPlayhead() {
      const ctx = this.ctx;
      const x = this.timeToX(this.playheadTime);
      if (x < KEYBOARD_W || x > this.canvas.clientWidth) return;
      ctx.strokeStyle = css('--playhead', '#4be0a0');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H);
      ctx.lineTo(x + 0.5, this.canvas.clientHeight);
      ctx.stroke();
      // Cap triangle on the ruler.
      ctx.fillStyle = css('--playhead', '#4be0a0');
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER_H);
      ctx.lineTo(x + 5, RULER_H);
      ctx.lineTo(x, RULER_H - 6);
      ctx.closePath();
      ctx.fill();
    }

    // Draw the left gutter as a real black-and-white piano keyboard. Each
    // semitone is one row (so blob rows line up exactly with their keys):
    // white keys are full-width white rows with dark labels; black keys are
    // shorter, darker keys overlaid on top with a subtle bevel.
    _drawKeyboard() {
      const ctx = this.ctx;
      const H = this.canvas.clientHeight;
      const sh = this.semitoneH;
      const topM = this.visibleMidiHi;
      const botM = this.visibleMidiLo;

      const whiteFill = css('--white-key', '#e8eaef');
      const whiteEdge = css('--white-key-sep', '#b7bcc7');
      const blackFill = css('--black-key', '#12151b');
      const labelCol = css('--key-label', '#2b303b');

      // Base: fill the whole gutter white (background behind all keys).
      ctx.fillStyle = whiteFill;
      ctx.fillRect(0, RULER_H, KEYBOARD_W - 1, H - RULER_H);

      // Pass 1: white keys + separators between them.
      for (let m = botM; m <= topM; m++) {
        if (global.Pitch.isBlackKey(m)) continue;
        const yBottom = this.midiToY(m);       // bottom edge of this row
        const yTop = yBottom - sh;             // top edge of this row
        // Slightly brighter top for a subtle gloss on each white key.
        const grad = ctx.createLinearGradient(0, yTop, 0, yBottom);
        grad.addColorStop(0, '#f4f5f8');
        grad.addColorStop(0.5, whiteFill);
        grad.addColorStop(1, '#dfe2e9');
        ctx.fillStyle = grad;
        ctx.fillRect(0, yTop, KEYBOARD_W - 1, sh);
        // Separator line at the bottom of each white key.
        ctx.strokeStyle = whiteEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yBottom + 0.5);
        ctx.lineTo(KEYBOARD_W - 1, yBottom + 0.5);
        ctx.stroke();
      }

      // Pass 2: black keys, overlaid, ~62% of the gutter width and inset
      // vertically so they read as raised keys sitting between the whites.
      const blackW = Math.round((KEYBOARD_W - 1) * 0.62);
      const inset = Math.min(2, sh * 0.14);
      for (let m = botM; m <= topM; m++) {
        if (!global.Pitch.isBlackKey(m)) continue;
        const yBottom = this.midiToY(m);
        const yTop = yBottom - sh + inset;
        const kh = sh - inset * 2;
        ctx.fillStyle = blackFill;
        ctx.fillRect(0, yTop, blackW, kh);
        // Thin highlight along the front (right) edge for a bevel.
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(blackW - 2, yTop, 2, kh);
      }

      // Flash overlay: highlight a key briefly when it is clicked/played.
      if (this.flashKey != null && this.flashKey >= botM && this.flashKey <= topM) {
        const m = this.flashKey;
        const yBottom = this.midiToY(m);
        const black = global.Pitch.isBlackKey(m);
        const w = black ? blackW : KEYBOARD_W - 1;
        const yy = black ? yBottom - sh + inset : yBottom - sh;
        const hh = black ? sh - inset * 2 : sh;
        ctx.fillStyle = css('--accent', '#ff8c3b');
        ctx.globalAlpha = 0.55;
        ctx.fillRect(0, yy, w, hh);
        ctx.globalAlpha = 1;
      }

      // Pass 3: labels. Always label C's; label every white key when there is
      // vertical room. Drawn on white keys in dark ink.
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      for (let m = botM; m <= topM; m++) {
        if (global.Pitch.isBlackKey(m)) continue;
        const isC = ((m % 12) + 12) % 12 === 0;
        if (!isC && sh < 16) continue;
        const yMid = this.midiToY(m) - sh / 2;
        ctx.fillStyle = labelCol;
        ctx.font = (isC ? 'bold ' : '') + '9px -apple-system, sans-serif';
        ctx.fillText(global.Pitch.midiToName(m), KEYBOARD_W - 5, yMid);
      }

      // Right border of the keyboard gutter.
      ctx.strokeStyle = css('--edge', '#2e3743');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(KEYBOARD_W - 0.5, RULER_H);
      ctx.lineTo(KEYBOARD_W - 0.5, H);
      ctx.stroke();
    }

    _drawRuler() {
      const ctx = this.ctx;
      const W = this.canvas.clientWidth;
      ctx.fillStyle = css('--panel-2', '#232a34');
      ctx.fillRect(0, 0, W, RULER_H);
      ctx.strokeStyle = css('--edge', '#2e3743');
      ctx.beginPath();
      ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(W, RULER_H - 0.5); ctx.stroke();

      const targetPx = 90;
      const step = niceTimeStep(targetPx / this.pxPerSec);
      const first = Math.ceil(this.scrollX / step) * step;
      const end = this.xToTime(W);
      ctx.fillStyle = css('--muted', '#8593a5');
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let t = first; t <= end; t += step) {
        const x = this.timeToX(t);
        if (x < KEYBOARD_W) continue;
        ctx.strokeStyle = css('--edge', '#2e3743');
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H - 7); ctx.lineTo(x + 0.5, RULER_H); ctx.stroke();
        ctx.fillText(fmtTime(t), x + 3, RULER_H / 2);
      }
    }

    // ---- interaction ----
    _bindEvents() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this._onDown(e));
      c.addEventListener('pointermove', (e) => this._onMove(e));
      c.addEventListener('pointerup', (e) => this._onUp(e));
      c.addEventListener('pointerleave', () => { this.canvas.style.cursor = 'crosshair'; });
      c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    }

    _localXY(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _hitNote(x, y) {
      // Iterate in reverse so topmost drawn wins.
      for (let i = this.notes.length - 1; i >= 0; i--) {
        const n = this.notes[i];
        const nx = this.timeToX(n.startTime);
        const nw = Math.max(3, n.duration * this.pxPerSec);
        const yCenter = this.midiToY(n.midi) - this.semitoneH / 2;
        const h = this.semitoneH * 0.82;
        if (x >= nx && x <= nx + nw && y >= yCenter - h / 2 - 3 && y <= yCenter + h / 2 + 3) {
          return n;
        }
      }
      return null;
    }

    _onDown(e) {
      const { x, y } = this._localXY(e);
      this.canvas.setPointerCapture(e.pointerId);

      // Click in ruler / grid empty area = seek.
      if (y < RULER_H && x > KEYBOARD_W) {
        const t = clamp(this.xToTime(x), 0, this.duration);
        if (this.cb.onSeek) this.cb.onSeek(t);
        return;
      }
      // Click on the left keyboard = audition that key's pitch.
      if (x < KEYBOARD_W) {
        if (y > RULER_H) {
          const midi = clamp(Math.floor(this.yToMidi(y)), MIN_MIDI, MAX_MIDI);
          if (this.cb.onKeyPlay) this.cb.onKeyPlay(midi);
          this.flashKey = midi;
          this.render();
          clearTimeout(this._flashTimer);
          this._flashTimer = setTimeout(() => { this.flashKey = null; this.render(); }, 160);
        }
        return;
      }

      const note = this._hitNote(x, y);
      // Update selection.
      for (const n of this.notes) n.selected = false;
      if (note) {
        note.selected = true;
        this.drag = {
          note,
          startY: y,
          startOffset: note.pitchOffset,
          moved: false,
        };
        this.canvas.style.cursor = 'ns-resize';
        if (this.cb.onSelect) this.cb.onSelect(note);
      } else {
        if (this.cb.onSelect) this.cb.onSelect(null);
      }
      this.render();
    }

    _onMove(e) {
      const { x, y } = this._localXY(e);
      if (this.drag) {
        const dy = y - this.drag.startY;
        const deltaSemi = -dy / this.semitoneH; // up = higher pitch
        const rawOffset = this.drag.startOffset + deltaSemi;
        const det = this.drag.note.detectedMidi;
        // Clamp so the edited pitch stays within C0..C6.
        const loOff = Math.ceil(MIN_MIDI - det);
        const hiOff = Math.floor(MAX_MIDI - det);
        const snapped = clamp(Math.round(rawOffset), loOff, hiOff);
        if (snapped !== this.drag.note.pitchOffset) {
          this.drag.note.pitchOffset = snapped;
          if (this.cb.onEdit) this.cb.onEdit(this.drag.note);
        }
        this.drag.moved = true;
        this.render();
        return;
      }
      // Hover cursor feedback.
      if (x < KEYBOARD_W && y > RULER_H) {
        this.canvas.style.cursor = 'pointer';   // clickable piano keys
      } else if (x > KEYBOARD_W && y > RULER_H) {
        this.canvas.style.cursor = this._hitNote(x, y) ? 'ns-resize' : 'crosshair';
      } else {
        this.canvas.style.cursor = 'default';
      }
    }

    _onUp(e) {
      if (this.drag) {
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        this.drag = null;
        this.canvas.style.cursor = 'crosshair';
        this.render();
      }
    }

    _onWheel(e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Zoom time around cursor.
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomX = clamp(this.zoomX * factor, 0.25, 8);
        this.render();
      } else if (e.shiftKey) {
        // Vertical scroll (pitch).
        this.scrollVertical(e.deltaY * 0.03);
      } else {
        // Horizontal scroll (time).
        this.scrollX = Math.max(0, this.scrollX + (e.deltaY + e.deltaX) / this.pxPerSec);
        this.render();
      }
    }

    scrollVertical(semitones) {
      this.topMidi -= semitones;
      this._clampScroll();
      this.render();
    }
  }

  // ---- helpers ----
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function niceTimeStep(raw) {
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    for (const s of steps) if (s >= raw) return s;
    return 120;
  }
  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  const _cssCache = {};
  function css(varName, fallback) {
    if (_cssCache[varName]) return _cssCache[varName];
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    _cssCache[varName] = v || fallback;
    return _cssCache[varName];
  }

  global.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
