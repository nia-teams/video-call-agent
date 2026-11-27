// Copyright (c) 2026 Nia Teams and Video Call Agent contributors. SPDX-License-Identifier: MIT
// Independent, local PCM-to-mouth animation. No speech/model SDK is required.
// Spectral cues approximate articulation; they do not transcribe or identify phonemes.
(() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const bands = [250, 400, 650, 900, 1200, 1600, 2100, 2700, 3400];
  class SpeechLipSync {
    constructor(sampleRate = 24000) {
      this.setSampleRate(sampleRate);
    }
    setSampleRate(sampleRate) {
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Unsupported PCM sample rate');
      this.sampleRate = sampleRate;
      this.frameSize = Math.round(sampleRate * .02);
      this.queue = new Float32Array(Math.ceil(sampleRate * .18));
      this.frame = new Float32Array(this.frameSize);
      this.window = Float32Array.from({ length: this.frameSize }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (this.frameSize - 1)));
      this.coefficients = bands.map(hz => 2 * Math.cos(2 * Math.PI * hz / sampleRate));
      this.reset();
    }
    reset() {
      this.read = 0;
      this.queuedSamples = 0;
      this.frameCount = 0;
      this.sampleClock = 0;
      this.open = 0;
      this.width = 1;
      this.round = 0;
      this.level = 0;
      this.target = { open: 0, width: 1, round: 0, level: 0 };
      this.frame.fill(0);
    }
    push(samples, sampleRate = this.sampleRate) {
      if (sampleRate !== this.sampleRate) this.setSampleRate(sampleRate);
      // Retain the newest 180 ms: delayed/background viewers must not replay a backlog.
      const start = Math.max(0, samples.length - this.queue.length);
      for (let i = start; i < samples.length; i++) {
        if (this.queuedSamples === this.queue.length) {
          this.read = (this.read + 1) % this.queue.length;
          this.queuedSamples--;
        }
        this.queue[(this.read + this.queuedSamples) % this.queue.length] = Number.isFinite(samples[i]) ? clamp(samples[i], -1, 1) : 0;
        this.queuedSamples++;
      }
    }
    analyze() {
      const count = this.frameSize;
      let mean = 0, energy = 0;
      for (let i = 0; i < count; i++) mean += this.frame[i];
      mean /= count;
      for (let i = 0; i < count; i++) {
        const sample = this.frame[i] - mean;
        energy += sample * sample;
        this.frame[i] = sample * this.window[i];
      }
      const rms = Math.sqrt(energy / count);
      if (rms < .006) {
        this.target = { open: 0, width: 1, round: 0, level: 0 };
        return;
      }
      // Goertzel measures a small, fixed bank of frequencies, without an FFT dependency.
      const power = this.coefficients.map(coefficient => {
        let a = 0, b = 0;
        for (let i = 0; i < count; i++) {
          const value = this.frame[i] + coefficient * a - b;
          b = a; a = value;
        }
        return Math.max(0, a * a + b * b - coefficient * a * b);
      });
      const low = power[0] + power[1] + power[2];
      const mid = power[3] + power[4];
      const high = power[5] + power[6] + power[7] + power[8];
      const total = low + mid + high + 1e-12;
      const spread = high / total;
      const rounded = clamp((low / total - .38) * 1.5, 0, 1) * (1 - spread);
      const level = clamp(Math.log1p(Math.max(0, rms - .006) * 28) / Math.log1p(.3 * 28), 0, 1);
      this.target = {
        open: level * (.78 + .22 * mid / total) * (1 - .32 * rounded),
        width: clamp(1 + .26 * spread - .3 * rounded, .7, 1.26),
        round: rounded,
        level,
      };
    }
    step(seconds) {
      const dt = Number.isFinite(seconds) ? clamp(seconds, 0, .1) : 0;
      this.sampleClock += dt * this.sampleRate;
      const count = Math.floor(this.sampleClock);
      this.sampleClock -= count;
      const blend = time => 1 - Math.exp(-1 / (this.sampleRate * time));
      const attack = blend(.035), release = blend(.065), shape = blend(.055), level = blend(.045);
      // Silence fills missing samples so partial frames drain and the mouth closes.
      for (let i = 0; i < count; i++) {
        let sample = 0;
        if (this.queuedSamples) {
          sample = this.queue[this.read];
          this.read = (this.read + 1) % this.queue.length;
          this.queuedSamples--;
        }
        this.frame[this.frameCount++] = sample;
        if (this.frameCount === this.frameSize) {
          this.analyze();
          this.frameCount = 0;
        }
        // Smoothing follows audio time, independent of rendering and packet boundaries.
        this.open += (this.target.open - this.open) * (this.target.open > this.open ? attack : release);
        this.width += (this.target.width - this.width) * shape;
        this.round += (this.target.round - this.round) * shape;
        this.level += (this.target.level - this.level) * level;
      }
      if (this.open < .0005 && this.target.open === 0) this.open = 0;
      if (this.round < .0005 && this.target.round === 0) this.round = 0;
      return { open: this.open, width: this.width, round: this.round, level: this.level };
    }
  }
  globalThis.SpeechLipSync = SpeechLipSync;
})();
