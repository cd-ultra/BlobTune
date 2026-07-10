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
      this.scrollY = 0;              // top midi shown (float)
      this.topMidi = 84;            // C6 near top by default
      this.bottomMidi = 45;         // A2 near bottom
      this.playheadTime = 0;

      // Interaction state
      this.drag = null;
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

    _fitPitchRange() {
      if (!this.notes.length) { this.topMidi = 84; this.bottomMidi = 45; return; }
      let lo = Infinity, hi = -Infinity;
      for (const n of this.notes) {
        lo = Math.min(lo, n.detectedMidi);
        hi = Math.max(hi, n.detectedMidi);
      }
      this.topMidi = Math.ceil(hi) + 4;
      this.bottomMidi = Math.floor(lo) - 4;
      if (this.topMidi - this.bottomMidi < 18) {
        const mid = (this.topMidi + this.bottomMidi) / 2;
        this.topMidi = Math.round(mid + 9);
        this.bottomMidi = Math.round(mid - 9);
      }
    }

    // ---- geometry ----
    get gridW() { return this.canvas.clientWidth - KEYBOARD_W; }
    get gridH() { return this.canvas.clientHeight - RULER_H; }
    get pxPerSec() { return PX_PER_SEC * this.zoomX; }
    get semitoneH() { return SEMITONE_H * this.zoomY; }

    timeToX(t) { return KEYBOARD_W + (t - this.scrollX) * this.pxPerSec; }
    xToTime(x) { return this.scrollX + (x - KEYBOARD_W) / this.pxPerSec; }
    midiToY(midi) { return RULER_H + (this.topMidi - midi) * this.semitoneH; }
    yToMidi(y) { return this.topMidi - (y - RULER_H) / this.semitoneH; }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = Math.max(1, global.devicePixelRatio || 1);
      this.canvas.width = Math.round(rect.width * this.dpr);
      this.canvas.height = Math.round(rect.height * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.render();
    }

    zoom(factor, axis) {
      if (axis === 'y') this.zoomY = clamp(this.zoomY * factor, 0.5, 3);
      else this.zoomX = clamp(this.zoomX * factor, 0.25, 8);
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
      const topM = Math.ceil(this.topMidi);
      const botM = Math.floor(this.bottomMidi);
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

    _drawKeyboard() {
      const ctx = this.ctx;
      const H = this.canvas.clientHeight;
      ctx.fillStyle = css('--panel-2', '#232a34');
      ctx.fillRect(0, RULER_H, KEYBOARD_W, H - RULER_H);
      const topM = Math.ceil(this.topMidi);
      const botM = Math.floor(this.bottomMidi);
      for (let m = botM; m <= topM; m++) {
        const y = this.midiToY(m);
        const black = global.Pitch.isBlackKey(m);
        ctx.fillStyle = black ? css('--black-key', '#171b22') : css('--white-key', '#202631');
        ctx.fillRect(0, y - this.semitoneH, KEYBOARD_W - 1, this.semitoneH - 1);
        // Label C notes (and all notes when zoomed in enough).
        const isC = ((m % 12) + 12) % 12 === 0;
        if (isC || this.semitoneH > 16) {
          ctx.fillStyle = black ? '#6c7787' : css('--muted', '#8593a5');
          ctx.font = (isC ? 'bold ' : '') + '9px -apple-system, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'right';
          ctx.fillText(global.Pitch.midiToName(m), KEYBOARD_W - 5, y - this.semitoneH / 2);
        }
      }
      ctx.strokeStyle = css('--edge', '#2e3743');
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
      if (x < KEYBOARD_W) return;

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
        const snapped = Math.round(rawOffset);
        if (snapped !== this.drag.note.pitchOffset) {
          this.drag.note.pitchOffset = snapped;
          if (this.cb.onEdit) this.cb.onEdit(this.drag.note);
        }
        this.drag.moved = true;
        this.render();
        return;
      }
      // Hover cursor feedback.
      if (x > KEYBOARD_W && y > RULER_H) {
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
      this.bottomMidi -= semitones;
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
