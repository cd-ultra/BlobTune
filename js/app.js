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
  let undoStack = [];        // history of pitch-edit snapshots
  let redoStack = [];
  let pendingSnapshot = null;// state captured at the start of the current edit
  let mediaRecorder = null;  // active MediaRecorder while recording
  let recChunks = [];        // recorded Blob chunks
  let recStream = null;      // the live mic MediaStream
  let recStartMs = 0;        // performance.now() when recording started
  let recTimerId = null;     // interval id for the elapsed-time display
  let recMime = '';          // negotiated MediaRecorder mimeType
  let meterCtx = null;       // AudioContext driving the input-level meter
  let meterSource = null;    // MediaStreamAudioSourceNode
  let meterAnalyser = null;  // AnalyserNode
  let meterData = null;      // time-domain sample buffer
  let meterRaf = null;       // RAF id for the meter loop

  const els = {
    canvas: document.getElementById('piano-roll'),
    play: document.getElementById('btn-play'),
    stop: document.getElementById('btn-stop'),
    demo: document.getElementById('btn-demo'),
    reset: document.getElementById('btn-reset'),
    export: document.getElementById('btn-export'),
    exportMidi: document.getElementById('btn-export-midi'),
    midiInput: document.getElementById('midi-input'),
    record: document.getElementById('btn-record'),
    undo: document.getElementById('btn-undo'),
    redo: document.getElementById('btn-redo'),
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
    meter: document.getElementById('level-meter'),
    meterFill: document.getElementById('level-fill'),
  };

  function init() {
    renderer = new Renderer(els.canvas, {
      onSelect: onSelectNote,
      onEdit: onEditNote,
      onKeyPlay: onKeyPlay,
      onEditBegin: beginEdit,
      onSeek: (t) => { engine.seek(t); renderer.setPlayhead(t); },
    });

    els.play.addEventListener('click', togglePlay);
    els.stop.addEventListener('click', stopPlayback);
    els.demo.addEventListener('click', loadDemo);
    els.reset.addEventListener('click', resetEdits);
    els.export.addEventListener('click', exportWav);
    els.exportMidi.addEventListener('click', exportMidi);
    els.record.addEventListener('click', toggleRecord);
    els.undo.addEventListener('click', doUndo);
    els.redo.addEventListener('click', doRedo);
    els.zoomIn.addEventListener('click', () => renderer.zoom(1.3, 'x'));
    els.zoomOut.addEventListener('click', () => renderer.zoom(1 / 1.3, 'x'));
    els.file.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
    });
    els.midiInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) importMidi(e.target.files[0]);
      e.target.value = '';   // allow re-importing the same file
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
    // Decode through the engine's single, reused AudioContext (see engine.decode).
    engine.decode(arrayBuffer)
      .then((audioBuffer) => {
        engine.loadAudioBuffer(audioBuffer);
        setStatus('Analyzing ' + label + ' (' + engine.duration.toFixed(1) + 's)…');
        setTimeout(() => analyzeCurrent('Loaded ' + label), 20);
      })
      .catch((err) => {
        hideLoading();
        setStatus('Could not decode ' + label + ': ' + (err && err.message || err) +
          '. The recording may be empty or in an unsupported format.');
      });
  }

  // ---------- MIDI import ----------
  function importMidi(file) {
    stopPlayback();
    sourceName = file.name.replace(/\.[^.]+$/, '') || 'midi';
    showLoading('Reading MIDI…');
    const reader = new FileReader();
    reader.onload = () => setTimeout(() => {
      try {
        const parsed = MIDI.parseMidi(reader.result);
        if (!parsed.length) {
          hideLoading();
          setStatus('No notes found in "' + file.name + '".');
          return;
        }
        // Build blobs straight from the MIDI notes (no pitch detection needed).
        notes = parsed.map((p) => new Notes.Note(
          p.startTime, p.endTime, p.midi,
          [{ t: p.startTime, midi: p.midi }, { t: p.endTime, midi: p.midi }]
        ));
        clearHistory();
        // Synthesize a matching tone preview so playback and WAV export work.
        const sr = 44100;
        engine.loadSamples(synthesizeFromNotes(notes, sr), sr);
        engine.setNotes(notes);
        engine.markDirty();
        renderer.setNotes(notes, engine.duration);
        renderer.setPlayhead(0);
        hideLoading();
        setStatus('Imported ' + notes.length + ' notes from "' + file.name +
          '" (tone preview synthesized). Retune, play, or export WAV/MIDI.');
        els.selection.textContent = '';
      } catch (err) {
        hideLoading();
        setStatus('Could not read MIDI "' + file.name + '": ' + err.message);
      }
    }, 20);
    reader.readAsArrayBuffer(file);
  }

  // Render a simple sine+harmonics tone per note so imported MIDI (which has
  // no audio) is playable and exportable through the same engine.
  function synthesizeFromNotes(noteList, sr) {
    let end = 0;
    for (const n of noteList) end = Math.max(end, n.endTime);
    const out = new Float32Array(Math.max(1, Math.ceil((end + 0.3) * sr)));
    for (const n of noteList) {
      const freq = Pitch.midiToFreq(Math.round(n.detectedMidi));
      const start = Math.floor(n.startTime * sr);
      const len = Math.max(1, Math.floor((n.endTime - n.startTime) * sr));
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx >= out.length) break;
        const p = i / len;
        const env = Math.min(1, p / 0.02) * Math.min(1, (1 - p) / 0.05);
        const ph = (2 * Math.PI * freq * i) / sr;
        const s = Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph);
        out[idx] += 0.24 * env * s;
      }
    }
    return out;
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

  // ---------- microphone recording + level meter ----------

  // Pick a container/codec MediaRecorder actually supports on this browser.
  // Chrome/Firefox favour WebM/Opus; Safari only offers MP4/AAC. Returning ''
  // lets MediaRecorder fall back to its own default.
  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined' ||
        typeof MediaRecorder.isTypeSupported !== 'function') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function toggleRecord() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
        typeof MediaRecorder === 'undefined') {
      setStatus('Recording is not supported in this browser. Try a recent Chrome, Edge, Firefox, or Safari.');
      return;
    }
    els.record.disabled = true;
    setStatus('Requesting microphone access…');
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(startRecording)
      .catch((err) => {
        els.record.disabled = false;
        const name = err && err.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('Microphone permission denied. Click the camera/lock icon in the address bar to allow ' +
            'the mic, then try Record again. (The page must be served over https:// or http://localhost.)');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setStatus('No microphone was found. Connect an input device and try again.');
        } else {
          setStatus('Microphone unavailable (' + (name || 'error') + '). ' +
            'Grant mic permission and serve the page over https:// or http://localhost.');
        }
      });
  }

  function startRecording(stream) {
    stopPlayback();
    els.record.disabled = false;
    recStream = stream;
    recChunks = [];
    recMime = pickMimeType();
    try {
      mediaRecorder = recMime
        ? new MediaRecorder(stream, { mimeType: recMime })
        : new MediaRecorder(stream);
    } catch (err) {
      // Fall back to the UA default if the chosen mimeType was rejected.
      try { mediaRecorder = new MediaRecorder(stream); recMime = ''; }
      catch (err2) {
        setStatus('Could not start recorder: ' + (err2.message || err.message));
        releaseStream();
        return;
      }
    }
    recMime = mediaRecorder.mimeType || recMime;
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.onerror = (e) => {
      setStatus('Recording error: ' + ((e.error && e.error.name) || 'unknown') + '.');
      stopRecording();
    };
    // Timeslice so chunks flush periodically (more robust than a single blob at stop).
    mediaRecorder.start(250);
    recStartMs = performance.now();
    startRecTimer();
    startMeter(stream);
    els.record.classList.add('recording');
    setStatus('Recording… click Stop when done. Works best on a clean, single-note line (voice, whistle, one instrument).');
  }

  function startRecTimer() {
    updateRecLabel();
    if (recTimerId) clearInterval(recTimerId);
    recTimerId = setInterval(updateRecLabel, 200);
  }
  function stopRecTimer() {
    if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
  }
  function updateRecLabel() {
    const secs = Math.max(0, (performance.now() - recStartMs) / 1000);
    els.record.textContent = '■ Stop ' + fmt(secs);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (_) {}
    }
  }

  function onRecordingStop() {
    const mime = (mediaRecorder && mediaRecorder.mimeType) || recMime || 'audio/webm';
    const elapsed = (performance.now() - recStartMs) / 1000;
    stopRecTimer();
    els.record.classList.remove('recording');
    els.record.textContent = '● Record';
    stopMeter();
    releaseStream();
    const blob = new Blob(recChunks, { type: mime });
    recChunks = [];
    mediaRecorder = null;
    if (!blob.size) {
      setStatus('Recording was empty — nothing was captured. Check that the right microphone is selected and try again.');
      return;
    }
    if (elapsed < 0.35) {
      setStatus('Recording was too short (' + elapsed.toFixed(2) + 's). Hold Record for at least half a second, then try again.');
      return;
    }
    sourceName = 'recording';
    showLoading('Processing recording…');
    blob.arrayBuffer()
      .then((ab) => decodeAndAnalyze(ab, 'microphone recording'))
      .catch((err) => { hideLoading(); setStatus('Could not read recording: ' + (err && err.message || err)); });
  }

  function releaseStream() {
    if (recStream) {
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
    }
  }

  // Live input-level meter: tap the mic stream with an AnalyserNode and paint
  // an RMS bar (turning red near clipping) each frame while recording. Purely
  // a visual aid — failures here never affect the actual recording.
  function startMeter(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      meterCtx = new AC();
      // Created inside the getUserMedia promise (past the user gesture), so it
      // may start suspended; resume it or the graph won't process and the
      // analyser reads silence.
      if (meterCtx.state === 'suspended') meterCtx.resume();
      meterSource = meterCtx.createMediaStreamSource(stream);
      meterAnalyser = meterCtx.createAnalyser();
      meterAnalyser.fftSize = 1024;
      meterData = new Float32Array(meterAnalyser.fftSize);
      meterSource.connect(meterAnalyser);   // not connected to destination — no monitoring/feedback
      els.meter.classList.remove('hidden');
      meterTick();
    } catch (_) { /* meter is optional */ }
  }

  function meterTick() {
    if (!meterAnalyser) return;
    meterAnalyser.getFloatTimeDomainData(meterData);
    let sum = 0, peak = 0;
    for (let i = 0; i < meterData.length; i++) {
      const v = meterData[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / meterData.length);
    // Mild gain + curve so normal singing fills a good chunk of the bar.
    const level = Math.min(1, Math.pow(rms * 2.2, 0.7));
    els.meterFill.style.width = (level * 100).toFixed(1) + '%';
    els.meterFill.classList.toggle('hot', peak > 0.92);
    meterRaf = requestAnimationFrame(meterTick);
  }

  function stopMeter() {
    if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    meterAnalyser = null;
    meterData = null;
    if (meterSource) { try { meterSource.disconnect(); } catch (_) {} meterSource = null; }
    if (meterCtx) { try { meterCtx.close(); } catch (_) {} meterCtx = null; }
    if (els.meter) els.meter.classList.add('hidden');
    if (els.meterFill) { els.meterFill.style.width = '0%'; els.meterFill.classList.remove('hot'); }
  }

  function analyzeCurrent(doneMsg) {
    showLoading('Detecting pitch…');
    // Defer so the loading overlay paints before the (sync) heavy work.
    setTimeout(() => {
      const mono = engine.getMono();
      const track = Pitch.detectPitchTrack(mono, engine.sampleRate);
      notes = Notes.segmentNotes(track);
      clearHistory();
      engine.setNotes(notes);
      engine.markDirty();
      renderer.setNotes(notes, engine.duration);
      renderer.setPlayhead(0);
      hideLoading();
      if (!notes.length) {
        setStatus(doneMsg + ' — but no clear pitches were detected. Try a louder, cleaner, single-note ' +
          'line (voice, whistle, or one instrument) and avoid background noise.');
      } else {
        setStatus(doneMsg + ' — detected ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') +
          '. Drag a blob up/down to change its pitch.');
      }
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
    commitEdit();
    engine.markDirty();
    onSelectNote(note);
    setStatus('Moved ' + Pitch.midiToName(note.detectedMidi) + ' → ' + note.name +
      ' (' + (note.pitchOffset > 0 ? '+' : '') + note.pitchOffset + ' semitones). Press Space to hear it.');
  }
  // Audition a piano key clicked on the left keyboard gutter.
  function onKeyPlay(midi) {
    engine.previewMidi(midi);
    setStatus('♪ ' + Pitch.midiToName(midi) + ' — click keys on the left to hear pitches.');
  }

  function resetEdits() {
    if (notes.some((n) => n.pitchOffset)) { beginEdit(); commitEdit(); }
    for (const n of notes) n.pitchOffset = 0;
    engine.markDirty();
    renderer.render();
    onSelectNote(null);
    setStatus('All pitch edits reset.');
  }

  // ---------- undo / redo ----------
  // Each history entry is a snapshot of every note's pitchOffset keyed by id,
  // so undo/redo restores pitch edits without touching the audio buffer.
  function captureState() { return notes.map((n) => ({ id: n.id, off: n.pitchOffset })); }
  function restoreState(snap) {
    const byId = new Map(snap.map((s) => [s.id, s.off]));
    for (const n of notes) if (byId.has(n.id)) n.pitchOffset = byId.get(n.id);
  }
  // Called just before an edit gesture (drag start / arrow / reset) begins.
  function beginEdit() { if (!pendingSnapshot) pendingSnapshot = captureState(); }
  // Commit the pending snapshot into the undo stack (clears redo).
  function commitEdit() {
    if (!pendingSnapshot) return;
    undoStack.push(pendingSnapshot);
    pendingSnapshot = null;
    redoStack = [];
    refreshHistoryButtons();
  }
  function clearHistory() {
    undoStack = []; redoStack = []; pendingSnapshot = null;
    refreshHistoryButtons();
  }
  function doUndo() {
    if (!undoStack.length) return;
    redoStack.push(captureState());
    restoreState(undoStack.pop());
    afterHistoryChange('Undo');
  }
  function doRedo() {
    if (!redoStack.length) return;
    undoStack.push(captureState());
    restoreState(redoStack.pop());
    afterHistoryChange('Redo');
  }
  function afterHistoryChange(label) {
    engine.markDirty();
    renderer.render();
    const sel = notes.find((n) => n.selected);
    onSelectNote(sel || null);
    refreshHistoryButtons();
    setStatus(label + ' — ' + notes.filter((n) => n.pitchOffset).length + ' note(s) currently edited.');
  }
  function refreshHistoryButtons() {
    if (els.undo) els.undo.disabled = !undoStack.length;
    if (els.redo) els.redo.disabled = !redoStack.length;
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

  function exportMidi() {
    if (!notes.length) {
      setStatus('No notes to export yet — load audio, record, or import MIDI first.');
      return;
    }
    try {
      const blob = MIDI.encodeMidiFromNotes(notes);
      const edits = notes.filter((n) => n.pitchOffset).length;
      triggerDownload(blob, sourceName + '-edited.mid');
      setStatus('Exported ' + sourceName + '-edited.mid (' + notes.length + ' notes, ' +
        edits + ' edited).');
    } catch (err) {
      setStatus('MIDI export failed: ' + err.message);
    }
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
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        e.preventDefault();
        if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) doRedo();
        else doUndo();
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'Escape') { stopPlayback(); }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        const sel = notes.find((n) => n.selected);
        if (sel) {
          e.preventDefault();
          const next = sel.pitchOffset + (e.code === 'ArrowUp' ? 1 : -1);
          // Clamp edited pitch within C0 (12) .. C6 (84).
          const eff = sel.detectedMidi + next;
          if (eff >= 12 && eff <= 84) {
            beginEdit();
            sel.pitchOffset = next;
            onEditNote(sel);
            renderer.render();
          }
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
