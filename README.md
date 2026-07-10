# BlobTune

An **educational, from-scratch clone of the core ideas behind [Melodyne](https://www.celemony.com/en/melodyne)** — the audio pitch/time editor famous for turning recorded audio into editable "blobs" on a piano-roll grid.

BlobTune loads an audio file (or a built-in demo tone), detects the notes in it with a real pitch-detection algorithm, draws each note as a draggable blob positioned by **pitch (vertical)** and **time (horizontal)**, and lets you drag blobs up and down to retune them — then hear the result. It is written in plain HTML/CSS/JavaScript using the Web Audio API, with **no build step and no external dependencies**, so it runs offline by just opening a file.

> This is a learning project that recreates a handful of Melodyne's *concepts*. It is not affiliated with Celemony, and it is nowhere near the real product in scope, quality, or polyphonic capability. See **Known limitations** below.

## Live demo

Hosted on GitHub Pages: **https://cd-ultra.github.io/BlobTune/**

Every push to `main` redeploys automatically via `.github/workflows/pages.yml`. (First-time setup: in the repo, **Settings → Pages → Build and deployment → Source: GitHub Actions**. The workflow attempts to enable this on its first run, but if the deploy job is blocked you may need to flip that toggle once.)

## Running it

Because browsers restrict `file://` pages, the most reliable way is a trivial static server from the project root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/ in Chrome/Chromium
```

Opening `index.html` directly also works in most browsers (everything is self-contained), but a local server avoids occasional cross-origin quirks.

On load the app **auto-generates a demo melody** and analyzes it, so you immediately see blobs. Click **Demo tone** to regenerate it, **Load audio** / drag-and-drop a file to analyze your own, or **Record** to capture straight from your microphone.

> **Microphone note:** browsers only allow mic access on a *secure context*. Serving from `http://localhost` (as above) or over HTTPS works; a bare `file://` page will have recording disabled. You'll be prompted to grant mic permission the first time.

## How to use

- **Play / Pause** — the ▶ button or **Space**.
- **Stop** — the ■ button or **Esc**.
- **Seek** — click in the time ruler across the top.
- **Record** — capture from your microphone. Click **Record** to start (the button pulses red and reads **Stop**), click again to finish; the recording is decoded and analyzed into blobs just like a loaded file. Great for singing/whistling/humming a line and correcting it. A **live input-level meter** appears next to the button while recording (green → yellow, turning red near clipping) so you can set your level.
- **Select a blob** — click it. Its detected note and any edit show in the status bar.
- **Retune** — drag a selected blob up/down (snaps to semitones), or use **↑ / ↓** arrow keys. The detected-pitch micro-curve moves with it.
- **Reset edits** — restore every blob to its detected pitch.
- **Import MIDI** — load a Standard MIDI File (`.mid`). Its notes become blobs directly (no pitch detection needed), and a simple tone preview is synthesized so you can play, retune, and export. Supports format 0 and 1, tempo changes, and running status.
- **Export WAV** — render the edited audio (with all your pitch changes baked in) and download it as a 16-bit PCM `.wav`. The file is named after the source (e.g. `demo-edited.wav`) and matches exactly what you hear on playback.
- **Export MIDI** — write the current notes (at their **edited** pitches) to a `.mid` file (format 0, 120 BPM). Round-trips cleanly with Import MIDI.
- **Zoom** — the **+ / −** buttons, `Ctrl/Cmd + scroll` (time zoom). Plain scroll pans time; `Shift + scroll` pans pitch.

## Architecture

The code is deliberately split by responsibility. Modules are plain IIFEs that hang a namespace off `window`, loaded in dependency order from `index.html` (no bundler).

| File | Responsibility |
|------|----------------|
| `index.html` | Markup, toolbar/transport, module load order. |
| `css/style.css` | Dark, DAW-like styling. |
| `js/pitch.js` | **Pitch detection.** The YIN algorithm over short overlapping Hann-windowed frames, with an RMS silence gate, producing a per-frame pitch track (time, frequency, clarity). Also holds shared music helpers (freq↔MIDI, note names, black-key test). |
| `js/midi.js` | **MIDI import/export.** A tiny Standard MIDI File reader/writer: `encodeMidiFromNotes` writes a format-0 SMF at the notes' edited pitches; `parseMidi` reads format 0/1 (tempo map, running status, note-on/off pairing) into a `{startTime, endTime, midi}` list. |
| `js/notes.js` | **The blob/note model.** Segments the per-frame pitch track into `Note` objects by grouping consecutive voiced frames of similar pitch (bridging short unvoiced gaps, dropping too-short blips). Each `Note` keeps its detected pitch, a non-destructive `pitchOffset`, and a detected-pitch curve. |
| `js/renderer.js` | **The piano-roll UI.** Owns the canvas and the view transform (zoom/scroll), draws the keyboard gutter, time ruler, grid, blobs, pitch curves and playhead, and handles pointer interaction (select + vertical drag to retune). Emits callbacks; knows nothing about audio. |
| `js/audio.js` | **Playback + pitch editing + export.** Renders an edited copy of the signal where each retuned note is pitch-shifted (OLA time-stretch + linear resample to preserve duration), plays it via `AudioBufferSourceNode`, tracks the playhead, and encodes the edited buffer to a 16-bit PCM WAV blob for download. |
| `js/app.js` | **Glue.** File/drag-drop loading, **microphone recording** (`getUserMedia` + `MediaRecorder`, decoded through the same pipeline), the built-in demo melody generator, running detection→segmentation, transport, the playhead animation loop, zoom, keyboard shortcuts and status text. |

### Signal flow

```
audio file / mic recording / demo tone
      │  decodeAudioData / synthesis
      ▼
mono Float32Array ──► Pitch.detectPitchTrack (YIN)
                              │  {times, freqs, clarities}
                              ▼
                     Notes.segmentNotes ──► Note[] (blobs)
                              │
   MIDI import ──► MIDI.parseMidi ──► Note[] ─┤  (skips detection; a tone
                              │                   preview is synthesized)
              ┌───────────────┴───────────────┐
              ▼                                ▼
      Renderer (draw + drag)          AudioEngine (pitch-shift + play)
              │  pitchOffset edits ───────────►│  re-render edited buffer
              ▼                                ▼
        piano-roll canvas                  speakers + playhead
```

## Pitch detection & shifting, briefly

- **Detection: YIN.** For each frame we compute the difference function, its cumulative-mean-normalized form, take the first dip below an absolute threshold, and parabolically interpolate for a sub-sample period. Clarity = `1 − d'(τ)`. Frames below a relative RMS floor are treated as unvoiced. Defaults: 2048-sample frames, 512-sample hop.
- **Segmentation.** Consecutive voiced frames within ~0.75 semitone of a running mean become one note; a jump beyond that starts a new one. Short (≤2-frame) unvoiced gaps are bridged; notes shorter than 4 frames are discarded.
- **Pitch shift.** Per edited note we OLA time-stretch the segment by the pitch ratio (Hann window, frame 1024 / synthesis hop 256) then linearly resample back to the original length, so pitch changes while duration stays put. Boundaries get a short crossfade to reduce clicks.

## Known limitations

This is an educational clone; it intentionally stops well short of Melodyne:

- **Monophonic only.** YIN estimates a single fundamental per frame. Chords/polyphony are not separated (Melodyne's DNA is exactly the hard polyphonic case).
- **Pitch edits only.** You can retune blobs but not move them in time, split/merge them, or edit formants, amplitude, or timing — real Melodyne does all of this.
- **Modest pitch-shift quality.** OLA + resample is simple and can smear transients or sound slightly "phasey," especially for large shifts. No formant preservation, so big shifts sound chipmunk-y/dark. A phase vocoder or PSOLA would sound better.
- **Playback is mono** and re-renders the whole edited buffer on play; large files take a moment.
- **Audio export is mono 16-bit WAV only** (matching the mono engine); no MP3/other compressed formats, and no undo/redo.
- **MIDI import synthesizes a plain tone preview**, not the original instrument, and flattens all channels/tracks into one blob list (it's monophonic-minded); overlapping/polyphonic MIDI will draw overlapping blobs and sum in the preview. MIDI export is a fixed 120 BPM, single track.
- **Detection is best on clean, sustained, single-note material** (voice, flute, synth). Noisy or percussive audio yields messy blobs.

## Why "from scratch"

Everything here — the YIN implementation, note segmentation, the canvas piano-roll and its interaction, and the OLA pitch shifter — is hand-written with no third-party libraries, so you can read the whole pipeline end to end.
