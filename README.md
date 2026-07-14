# BlobTune

An **educational, from-scratch clone of the core ideas behind [Melodyne](https://www.celemony.com/en/melodyne)** — the audio pitch/time editor famous for turning recorded audio into editable "blobs" on a piano-roll grid.

BlobTune loads an audio file (or a built-in demo tone), detects the notes in it with a real pitch-detection algorithm, draws each note as a draggable blob positioned by **pitch (vertical)** and **time (horizontal)**, and lets you drag blobs up and down to retune them — then hear the result. It is written in plain HTML/CSS/JavaScript using the Web Audio API, with **no build step and no external dependencies**, so it runs offline by just opening a file.

> This is a learning project that recreates a handful of Melodyne's *concepts*. It is not affiliated with Celemony, and it is nowhere near the real product in scope, quality, or polyphonic capability. See **Known limitations** below.

## Live demo

Hosted on GitHub Pages: **https://cd-ultra.github.io/BlobTune/**

Served straight from the repository via GitHub Pages' branch deploy — no build step. One-time setup: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`**. After that, every push to `main` republishes automatically. (`.nojekyll` tells Pages to skip Jekyll and serve the files as-is.)

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
- **Select a blob** — click it. Its edited note name, the deviation in **cents**, and the total offset show in the status bar (e.g. `C#4 +15¢ (detected C4, total +115¢)`).
- **Retune** — drag a selected blob up/down, or use **↑ / ↓** arrow keys. Both snap to the current **Step** (see below), so you can nudge a slightly-flat note into tune by single cents. The detected-pitch micro-curve moves with it.
- **Step** — the toolbar **Step** selector chooses how far each retune moves: **Whole tone (2 st)**, **Semitone (1 st)**, **10 cents**, **5 cents**, or **1 cent** (1 cent = 0.01 semitone). Fine steps make the drag near-continuous. Default is Semitone.
- **Length** — drag a selected blob's **right edge** (the cursor becomes ↔) to time-stretch that note longer or shorter (0.25×–4×). The note's audio is stretched to the new duration, every later note shifts along, and the total length grows/shrinks — so you can sustain a tone for longer. Undoable, and shown in the status bar and selection text.
- **Reset edits** — restore every blob to its detected pitch **and** original length.
- **Formants** — toggle formant preservation on pitch shifts (on by default). On, pitch-shifted notes keep the original vocal/instrument timbre; off is pure TD-PSOLA, which can lightly colour large shifts. Toggling re-renders on the next play/export.
- **Spectrogram** — show/hide a spectrogram of the audio behind the blobs, with frequency on the same pitch axis so harmonics line up with the note rows. Great for verifying detection and seeing vibrato/noise.
- **Import MIDI** — load a Standard MIDI File (`.mid`). Its notes become blobs directly (no pitch detection needed), and a simple tone preview is synthesized so you can play, retune, and export. Supports format 0 and 1, tempo changes, and running status.
- **Export WAV** — render the edited audio (with all your pitch changes baked in) and download it as a 16-bit PCM `.wav`. The file is named after the source (e.g. `demo-edited.wav`) and matches exactly what you hear on playback.
- **Export MIDI** — write the current notes (at their **edited** pitches) to a `.mid` file (format 0, 120 BPM). Round-trips cleanly with Import MIDI.
- **Zoom** — the **+ / −** buttons, `Ctrl/Cmd + scroll` (time zoom). Plain scroll pans time; `Shift + scroll` pans pitch.

## Architecture

The code is deliberately split by responsibility. Modules are plain IIFEs that hang a namespace off `window`, loaded in dependency order from `index.html` (no bundler).

| File | Responsibility |
|------|----------------|
| `index.html` | Markup, toolbar/transport, module load order. |
| `js/fft.js` | **A dependency-free radix-2 FFT** (in-place Cooley–Tukey, forward + inverse). Hand-written so BlobTune can do spectral analysis with no libraries or build step — used by onset detection, the spectrogram, and the cepstral formant-envelope estimator. |
| `js/onset.js` | **Spectral-flux onset detection.** STFTs the signal (on `fft.js`) and flags note attacks by the summed positive magnitude change per hop, with adaptive-threshold peak picking. Frame-aligned with the pitch track. Catches a re-articulated same-pitch note even with **no** amplitude dip — the aubio-style technique reimplemented in plain JS (GPL-free). |
| `js/spectrogram.js` | **STFT magnitude spectrogram** on `fft.js` — a windowed FFT per hop stored as per-bin decibels. Feeds the renderer's optional spectrogram underlay so you can see the harmonics, vibrato and noise behind each blob and eyeball the detection. |
| `css/style.css` | Dark, DAW-like styling. |
| `js/pitch.js` | **Pitch detection.** The YIN algorithm over short overlapping Hann-windowed frames, with an RMS silence gate and a voice-tuned frequency range, producing a per-frame pitch track (time, frequency, clarity, normalized RMS). A global Viterbi/DP pass re-aligns octaves across the whole track (`octaveViterbi`) and a local median pass mops up single-frame residue (`octaveCorrect`). Also holds shared music helpers (freq↔MIDI, note names, black-key test). |
| `js/midi.js` | **MIDI import/export.** A tiny Standard MIDI File reader/writer: `encodeMidiFromNotes` writes a format-0 SMF at the notes' edited pitches; `parseMidi` reads format 0/1 (tempo map, running status, note-on/off pairing) into a `{startTime, endTime, midi}` list. |
| `js/notes.js` | **The blob/note model.** Segments the per-frame pitch track into `Note` objects by grouping voiced frames of similar pitch — split decisions run on a median-smoothed pitch versus a robust trailing-median centre with hysteresis, so vibrato doesn't over-split a held note (bridging short unvoiced gaps, dropping too-short blips). A **spectral-flux onset** detector (`onset.js`) additionally splits a *same-pitch* run where the note is clearly re-articulated — even with no amplitude dip — so two struck notes at one pitch become two blobs (an energy dip-then-rise cue, `detectOnsets`, is the fallback). Each `Note` keeps its detected pitch, a non-destructive `pitchOffset`, and a detected-pitch curve. |
| `js/renderer.js` | **The piano-roll UI.** Owns the canvas and the view transform (zoom/scroll), draws the keyboard gutter, time ruler, grid, blobs, pitch curves and playhead, and handles pointer interaction (select + vertical drag to retune). Optionally paints a **spectrogram underlay** (`spectrogram.js` data) behind the blobs, mapped onto the same pitch axis via a cached offscreen bitmap that's blitted with one scaled `drawImage`. Emits callbacks; knows nothing about audio. |
| `js/audio.js` | **Playback + pitch/length editing + export.** Rebuilds the edited signal by walking the notes in time order (`layout` for cheap repositioning, `_renderEdited` for the audio): each note is pitch-shifted with **TD-PSOLA** (pitch-synchronous overlap-add, using its detected fundamental) *and* time-stretched to its target duration, with the inter-note audio copied between — so length edits grow/shrink the whole timeline. An optional **formant-preservation** stage (`preserveFormants`, cepstral spectral-envelope lock) keeps the source timbre on pitch shifts. Each note keeps its fixed **source** range (`srcStart`/`srcEnd`) separate from its editable `pitchOffset` and `stretch`, so pitch + length edits compose and reset cleanly. Plays via `AudioBufferSourceNode`, tracks the playhead, and encodes the edited buffer to a 16-bit PCM WAV. |
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

- **Detection: YIN.** For each frame we compute the difference function, its cumulative-mean-normalized form, take the first dip below an absolute threshold, and parabolically interpolate for a sub-sample period. Clarity = `1 − d'(τ)`. Frames below a relative RMS floor are treated as unvoiced. Voicing uses **hysteresis** — a frame only *enters* the voiced state above the clarity floor (~0.85) but *stays* voiced down to a lower floor (~0.70) while sound continues, so a breathy dip or a decaying tail isn't clipped. Defaults: 2048-sample frames, 512-sample hop, voice-tuned range ~80–1000 Hz.
- **Octave-jump repair (for singing).** YIN on a real voice latches onto twice/half the true period — sometimes for a *run* of frames, not just one — reading as a ±12-semitone leap and back. Two passes fix this. First a **global Viterbi/DP** pass (`Pitch.octaveViterbi`) picks, for every voiced frame, the octave from `{−12, 0, +12}` that minimizes total *leap cost* (semitone distance between adjacent frames) plus a small *trust cost* for shifting away from YIN's raw pick. Because a transient wrong-octave excursion costs two ~12-semitone leaps, it snaps back to the continuous line; because re-octaving a *sustained* note costs the trust penalty on every frame, a genuine octave leap between notes is preserved. Then the local-median `octaveCorrect` mops up any single-frame residue. On clean tones the raw path already has zero leaps and zero shift, so both passes are no-ops.
- **Segmentation.** Split decisions run on a **median-smoothed** copy of the per-frame MIDI (removes single-frame jitter) compared against the note's **robust centre** — the median of a trailing window rather than a running mean that a vibrato would bias. A frame only starts a new note when the smoothed pitch sits more than ~1.1 semitones from that centre **and stays there** (hysteresis, ~3 frames), so a vibrato wobble that snaps back is reabsorbed instead of shattering one held note into many blobs. **Re-articulation onsets** add a second split cue: a **spectral-flux** onset detector (`Onset.detect`, built on the hand-written `FFT`) sums the positive per-bin magnitude change each STFT hop and peak-picks it, so a same-pitch note that is re-attacked — *even with no amplitude dip* (legato tonguing/bowing) — is split into two blobs. An onset only splits a note that has already run a few frames, so a note's own attack doesn't split it; gentle vibrato/tremolo doesn't spike the flux. (A simpler energy dip-then-rise cue, `Notes.detectOnsets`, remains as a fallback.) The note's reported pitch is still the median of the *raw* frames, so accuracy is unchanged. Short (≤2-frame) unvoiced gaps are still bridged; notes shorter than 4 frames are discarded.
- **Pitch shift.** Per edited note we use **TD-PSOLA**: from the note's detected fundamental we lay pitch-synchronous Hann grains (window half-width `max(P, P/ratio)` so grains always keep ≥50% overlap) at the analysis period `P = sampleRate/f` and re-space them at `P/ratio`, each grain pulling the analysis grain nearest the same time — so pitch changes while duration is preserved, without the phasey warble of generic fixed-hop OLA. If a note has no usable pitch, it falls back to OLA time-stretch + resample. Boundaries get a short crossfade to reduce clicks.
- **Formant preservation (optional, on by default).** Because each TD-PSOLA grain retains the source waveform, TD-PSOLA already keeps formants *roughly* in place (unlike resampling, which shifts them wholesale — the classic "chipmunk" effect). An optional stage locks them explicitly: for each short STFT frame (source and shifted line up in time, since the shift preserves length) we estimate the smooth spectral envelope of both via **low-quefrency cepstral liftering** and scale the shifted spectrum by `envSource / envShifted`, then overlap-add. The lifter cutoff sits below the pitch period, so the gain is smooth in frequency and moves formants back to the source's without disturbing the (already shifted) pitch; when TD-PSOLA already preserved the envelope the gain is ≈1, so it only corrects residual drift. Measured on a synthetic vowel (fixed formants), an octave-up **resample** brightens the spectral centroid by ~60% while **TD-PSOLA** drifts only ~2–7% and the formant lock pulls that to ≈0. It also rescues the resample fallback path. Toggle with the **Formants** button.
- **Spectrogram view (optional).** The **Spectrogram** button paints an STFT magnitude spectrogram (`spectrogram.js`) behind the blobs, with frequency mapped onto the **same pitch axis** as the keyboard — so a note's fundamental lands on its blob and the harmonics stack above it. Handy for seeing vibrato, breathiness/noise, and octave ambiguities, and for sanity-checking the detection. It's computed once per clip (lazily, the first time you show it) and drawn as a cached bitmap, so scrolling and zooming stay cheap.

## Known limitations

This is an educational clone; it intentionally stops well short of Melodyne:

- **Monophonic only.** YIN estimates a single fundamental per frame. Chords/polyphony are not separated (Melodyne's DNA is exactly the hard polyphonic case).
- **Pitch and length edits.** You can retune blobs and change their length, but not move them freely in time, split/merge them, or edit amplitude — real Melodyne does all of this. Formants are *preserved* on shifts (see below) but not independently editable.
- **Formant preservation, not formant control.** Pitch shifts keep the source timbre via an optional cepstral spectral-envelope lock, so shifts don't drift chipmunk-y/dark (TD-PSOLA already mostly avoids that; the lock tightens the residual and rescues the resample fallback). But you can't yet *move* formants deliberately, and the envelope is a coarse cepstral estimate — very large or noisy/inharmonic shifts can still smear, and a full source-filter (LPC) model or a phase vocoder would go further.
- **Length edits are pitch-synchronous and transient-aware.** Extending a note (up to 4×) uses **TD-PSOLA** time-stretch driven by the note's fundamental, so pitch is preserved and it avoids the robotic/phasey warble of fixed-hop OLA (which is only the fallback when no pitch is known). A note's **onset attack is copied verbatim** and only the sustain is stretched, so a hard/percussive attack isn't duplicated or smeared. Stretching is still per-note, monophonic, and only along the note's own audio.
- **Playback is mono** and re-renders the whole edited buffer on play; large files take a moment.
- **Audio export is mono 16-bit WAV only** (matching the mono engine); no MP3/other compressed formats, and no undo/redo.
- **MIDI import synthesizes a plain tone preview**, not the original instrument, and flattens all channels/tracks into one blob list (it's monophonic-minded); overlapping/polyphonic MIDI will draw overlapping blobs and sum in the preview. MIDI export is a fixed 120 BPM, single track.
- **Detection is best on clean, sustained, single-note material** (voice, flute, synth). Noisy or percussive audio yields messy blobs.
- **Singing support is heuristic.** Median smoothing + hysteresis + Viterbi octave alignment + an energy-onset split make sustained sung notes (with vibrato) segment into stable blobs *and* separate two same-pitch notes struck back-to-back even without a silent gap. But the cues remain heuristic: the spectral-flux onset needs a clear attack, so a perfectly smooth legato re-articulation with no spectral change won't split, and a hard tremolo could in principle trip it; heavy vibrato wider than the ~1.1-semitone tolerance, or fast legato runs of steps ≤1 semitone, can still mis-segment; and the Viterbi trust penalty means a *genuine* octave leap onto a very short note (shorter than a wrong-octave excursion) could be pulled to the neighbouring octave. These improvements were validated on **one real dry solo vocal** plus **synthetic** signals (vibrato, a same-pitch repeat, and genuine octave leaps) — not on a broad range of microphones, voices, or singing styles.

## Why "from scratch"

Everything here — the YIN implementation, note segmentation, the FFT, the spectrogram, the cepstral formant-envelope lock, the canvas piano-roll and its interaction, and the TD-PSOLA pitch shifter — is hand-written with no third-party libraries, so you can read the whole pipeline end to end.
