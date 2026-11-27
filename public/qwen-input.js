// Runs at the actual AudioContext rate; emits 100 ms PCM16 mono frames.
class QwenInput extends AudioWorkletProcessor {
  constructor() { super(); this.phase = 0; this.sum = 0; this.count = 0; this.samples = []; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const ch of channels) sample += ch[i] / channels.length;
      this.sum += Number.isFinite(sample) ? sample : 0; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.samples.push(Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767)); this.sum = 0; this.count = 0;
        if (this.samples.length === 1600) {
          const bytes = new ArrayBuffer(3200), view = new DataView(bytes);
          this.samples.forEach((v, n) => view.setInt16(n * 2, v, true));
          this.port.postMessage(bytes, [bytes]); this.samples = [];
        }
      }
    }
    return true;
  }
}
registerProcessor('qwen-input', QwenInput);
