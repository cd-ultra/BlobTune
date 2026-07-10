/*
 * app.js — wires the modules together.
 *
 * Responsibilities:
 *  - file loading (picker + drag/drop) and the built-in demo tone
 *  - running detection (pitch.js) + segmentation (notes.js)
 *  - owning the Renderer and AudioEngine and keeping them in sync
 *  - transport (play/pause/stop), the playhead animation loop, zoom, status.
 */
(function () {
  'use strict';

  const engine = new AudioEngine();
  let renderer = null;
  let notes = [];
  let rafId = null;
  let sourceName = 'demo';   // base filename used when exporting
  let mediaRecorder = null;  // active MediaRecorder while recording
  let recChunks = [];        // recorded Blob chunks
  let recStream = null;      // the live mic MediaStream

  const els = {
    canvas: document.getElementById('piano-roll'),
    play: document.getElementById('btn-play'),
    stop: document.getElementById('btn-stop'),
    demo: document.getElementById('btn-demo'),
    reset: document.getElementById('btn-reset'),
    export: document.getElementById('btn-export'),
    record: document.getElementById('btn-record'),
    file: document.getElementById('file-input'),
    zoomIn: document.getElementById('zoom-in'),
    zoomOut: document.getElementById('zoom-out'),
    status: document.getElementById('status-text'),
    selection: document.getElementById('selection-text'),
    timeReadout: document.getElementById('time-readout'),
    loading: document.getElementById('loading'),
    loadingText: document.getElementById('loading-text'),
    dropHint: document.getElementById('drop-hint'),
    editorWrap: document.getElementById('editor-wrap'),
  };

  function init() {
    renderer = new Renderer(els.canvas, {
      onSelect: onSelectNote,
      onEdit: onEditNote,
      onSeek: (t) => { engine.seek(t); renderer.setPlayhead(t); },
    });

    els.play.addEventListener('click', togglePlay);
    els.stop.addEventListener('click', stopPlayback);
    els.demo.addEventListener('click', loadDemo);
    els.reset.addEventListener('click', resetEdits);
    els.export.addEventListener('click', exportWav);
    els.record.addEventListener('click', toggleRecord);
    els.zoomIn.addEventListener('click', () => renderer.zoom(1.3, 'x'));
    els.zoomOut.addEventListener('click', () => renderer.zoom(1 / 1.3, 'x'));
    els.file.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
    });

    engine.onEnded = () => {
      setPlaying(false);
      renderer.setPlayhead(0);
      engine.startOffset = 0;
    };

    setupDragDrop();
    setupKeyboard();
    window.addEventListener('resize', () => renderer.resize());

    // Auto-load the demo so the app is immediately usable / verifiable.
    loadDemo();
  }

  // ---------- loading ----------
  function showLoading(text) {
    els.loadingText.textContent = text || 'Analyzing…';
    els.loading.classList.remove('hidden');
  }
  function hideLoading() { els.loading.classList.add('hidden'); }

  function loadFile(file) {
    stopPlayback();
    sourceName = file.name.replace(/\.[^.]+$/, '') || 'audio';
    showLoading('Decoding ' + file.name + '…');
    const reader = new FileReader();
    reader.onload = () => decodeAndAnalyze(reader.result, '"' + file.name + '"');
    reader.readAsArrayBuffer(file);
  }

  // Decode an ArrayBuffer of any browser-supported audio (file or recording),
  // load it into the engine, and run the detection pipeline.
  function decodeAndAnalyze(arrayBuffer, label) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const tmp = new AC();
    tmp.decodeAudioData(arrayBuffer.slice(0))
      .then((audioBuffer) => {
        engine.loadAudioBuffer(audioBuffer);
        setStatus('Analyzing ' + label + ' (' + engine.duration.toFixed(1) + 's)…');
        setTimeout(() => analyzeCurrent('Loaded ' + label), 20);
      })
      .catch((err) => {
        hideLoading();
        setStatus('Could not decode ' + label + ': ' + err.message);
      });
  }

  function loadDemo() {
    stopPlayback();
    sourceName = 'demo';
    showLoading('Generating demo…');
    const sr = 44100;
    const samples = generateDemoMelody(sr);
    engine.loadSamples(samples, sr);
    setTimeout(() => analyzeCurrent('Loaded built-in demo melody'), 20);
  }

  // ---------- microphone recording ----------
  function toggleRecord() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
        typeof MediaRecorder === 'undefined') {
      setStatus('Recording is not supported in this browser.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(startRecording)
      .catch((err) => {
        setStatus('Microphone unavailable (' + err.name + '). ' +
          'Grant mic permission and serve the page over http://localhost or https.');
      });
  }

  function startRecording(stream) {
    stopPlayback();
    recStream = stream;
    recChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream);
    } catch (err) {
      setStatus('Could not start recorder: ' + err.message);
      releaseStream();
      return;
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start();
    els.record.classList.add('recording');
    els.record.textContent = '■ Stop';
    setStatus('Recording… click Stop when done. Works best on a clean, single-note line (voice, whistle, one instrument).');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  }

  function onRecordingStop() {
    const mime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
    els.record.classList.remove('recording');
    els.record.textContent = '● Record';
    releaseStream();
    const blob = new Blob(recChunks, { type: mime });
    recChunks = [];
    mediaRecorder = null;
    if (!blob.size) { setStatus('Recording was empty — nothing captured.'); return; }
    sourceName = 'recording';
    showLoading('Processing recording…');
    blob.arrayBuffer()
      .then((ab) => decodeAndAnalyze(ab, 'microphone recording'))
      .catch((err) => { hideLoading(); setStatus('Could not read recording: ' + err.message); });
  }

  function releaseStream() {
    if (recStream) {
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
    }
  }

  function analyzeCurrent(doneMsg) {
    showLoading('Detecting pitch…');
    // Defer so the loading overlay paints before the (sync) heavy work.
    setTimeout(() => {
      const mono = engine.getMono();
      const track = Pitch.detectPitchTrack(mono, engine.sampleRate);
      notes = Notes.segmentNotes(track);
      engine.setNotes(notes);
      engine.markDirty();
      renderer.setNotes(notes, engine.duration);
      renderer.setPlayhead(0);
      hideLoading();
      setStatus(doneMsg + ' — detected ' + notes.length + ' notes. Drag a blob up/down to change its pitch.');
      els.selection.textContent = '';
    }, 20);
  }

  // ---------- demo melody ----------
  // A short, slightly-out-of-tune melody so pitch correction is meaningful.
  function generateDemoMelody(sr) {
    // (midiNote, durationSeconds, detuneCents)
    const seq = [
      [60, 0.5, +18], [62, 0.5, -22], [64, 0.5, +8], [65, 0.5, +30],
      [67, 0.7, -15], [65, 0.4, +12], [64, 0.5, -28], [62, 0.5, +20],
      [60, 0.9, -10],
      [67, 0.5, +25], [69, 0.5, -18], [71, 0.6, +14], [72, 1.0, -24],
    ];
    let total = 0;
    for (const s of seq) total += s[1];
    const gap = 0.04;
    total += gap * seq.length + 0.3;
    const out = new Float32Array(Math.ceil(total * sr));

    let t = 0.1;
    for (const [midi, dur, cents] of seq) {
      const freq = Pitch.midiToFreq(midi + cents / 100);
      const start = Math.floor(t * sr);
      const n = Math.floor(dur * sr);
      for (let i = 0; i < n; i++) {
        const p = i / n;
        // Soft attack/release envelope.
        const env = Math.min(1, p / 0.06) * Math.min(1, (1 - p) / 0.15);
        const ph = (2 * Math.PI * freq * i) / sr;
        // A few harmonics so YIN has a clear periodic signal.
        const s = Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph);
        out[start + i] += 0.28 * env * s;
      }
      t += dur + gap;
    }
    return out;
  }

  // ---------- transport ----------
  function togglePlay() {
    if (engine.isPlaying) {
      engine.pause();
      setPlaying(false);
    } else {
      engine.play();
      setPlaying(true);
      startPlayheadLoop();
    }
  }
  function stopPlayback() {
    engine.stop();
    setPlaying(false);
    if (renderer) renderer.setPlayhead(0);
  }
  function setPlaying(on) {
    els.play.textContent = on ? '❚❚' : '▶';
    els.play.classList.toggle('playing', on);
    if (on) startPlayheadLoop();
  }
  function startPlayheadLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    const tick = () => {
      const t = engine.getCurrentTime();
      renderer.setPlayhead(t);
      els.timeReadout.textContent = fmt(t) + ' / ' + fmt(engine.duration);
      if (engine.isPlaying) rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- editing ----------
  function onSelectNote(note) {
    if (note) {
      els.selection.textContent =
        'Selected ' + note.name + '  (detected ' + Pitch.midiToName(note.detectedMidi) +
        (note.pitchOffset ? ', ' + (note.pitchOffset > 0 ? '+' : '') + note.pitchOffset + ' st' : '') + ')';
    } else {
      els.selection.textContent = '';
    }
  }
  function onEditNote(note) {
    engine.markDirty();
    onSelectNote(note);
    setStatus('Moved ' + Pitch.midiToName(note.detectedMidi) + ' → ' + note.name +
      ' (' + (note.pitchOffset > 0 ? '+' : '') + note.pitchOffset + ' semitones). Press Space to hear it.');
  }
  function resetEdits() {
    for (const n of notes) n.pitchOffset = 0;
    engine.markDirty();
    renderer.render();
    onSelectNote(null);
    setStatus('All pitch edits reset.');
  }

  // ---------- export ----------
  function exportWav() {
    if (!engine.getMono() || !engine.getMono().length) {
      setStatus('Nothing to export yet — load audio or the demo first.');
      return;
    }
    const wasPlaying = engine.isPlaying;
    if (wasPlaying) { engine.pause(); setPlaying(false); }
    showLoading('Rendering WAV…');
    // Defer so the overlay paints before the (sync) render/encode.
    setTimeout(() => {
      try {
        const samples = engine.getEditedSamples();
        const blob = DSP.encodeWavPCM16(samples, engine.sampleRate);
        const edits = notes.filter((n) => n.pitchOffset).length;
        triggerDownload(blob, sourceName + '-edited.wav');
        setStatus('Exported ' + sourceName + '-edited.wav (' + engine.duration.toFixed(1) +
          's, ' + edits + ' edited note' + (edits === 1 ? '' : 's') + ').');
      } catch (err) {
        setStatus('Export failed: ' + err.message);
      } finally {
        hideLoading();
      }
    }, 20);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- drag & drop ----------
  function setupDragDrop() {
    const wrap = document.body;
    let depth = 0;
    wrap.addEventListener('dragenter', (e) => {
      e.preventDefault(); depth++; els.dropHint.classList.remove('hidden');
    });
    wrap.addEventListener('dragover', (e) => e.preventDefault());
    wrap.addEventListener('dragleave', (e) => {
      e.preventDefault(); if (--depth <= 0) els.dropHint.classList.add('hidden');
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; els.dropHint.classList.add('hidden');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
  }

  // ---------- keyboard ----------
  function setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'Escape') { stopPlayback(); }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        const sel = notes.find((n) => n.selected);
        if (sel) {
          e.preventDefault();
          sel.pitchOffset += e.code === 'ArrowUp' ? 1 : -1;
          onEditNote(sel);
          renderer.render();
        }
      }
    });
  }

  // ---------- misc ----------
  function setStatus(msg) { els.status.textContent = msg; }
  function fmt(t) {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
