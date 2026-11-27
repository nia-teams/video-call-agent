# SpeechLipSync

SpeechLipSync animates the HeR avatar from mono PCM. It uses RMS energy and the Goertzel frequency measurement recurrence; it does not play audio or make network requests. The engine is released under the [MIT License](../../LICENSE).

## API

- **`SpeechLipSync`** (`globalThis.SpeechLipSync`): `push(Float32Array, sampleRate)` queues mono PCM. `step(elapsedSeconds)` returns `{ open, width, round, level }`. `reset()` discards queued PCM and immediately returns the animation to neutral.
- **`HeR.pushAudioSamples(samples, sampleRate)`** sends PCM to the engine; **`HeR.resetAudio()`** clears it; **`HeR.lipSyncSampleRate`** reports the current sample rate. Playback remains separate from the avatar.

## Processing and limits

The engine accepts 8–192 kHz PCM, keeps at most 180 ms of samples and analyzes 20 ms frames after removing DC offset and gating low-level input. RMS drives jaw opening; energy ratios across nine windowed frequency bands (250–3400 Hz) drive mouth width and rounding. Smoothing follows elapsed audio time rather than render timing or packet boundaries.

The engine sanitizes invalid samples, resets on sample-rate changes, and inserts silence when input stalls so the mouth returns to neutral. The analysis window and smoothing add delay. Timbre and background noise affect the result; the engine estimates mouth movement without recognizing words or aligning phonemes. The browser `attachAudio` path uses `ScriptProcessor`; direct PCM needs no `AudioContext` or microphone permission.

Run `npm run test:media` from the project root. Tests cover silence, energy and spectrum, sample rates, timing, buffer bounds, invalid samples, reset, and packet starvation.
