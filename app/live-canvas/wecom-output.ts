import { command } from '../studio/media';

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
export type OutputLevel = { rms: number; peak: number; received: boolean };
export async function createWecomAudioOutput(sink: string, label: string, signal: AbortSignal, onLevel: (level: OutputLevel) => void) {
  const expected = /Node Audio Send/i.test(label) ? 'Node Virtual Mic' : /BlackHole/i.test(label) ? 'BlackHole 2ch' : '';
  if (!sink || !expected) throw new Error('请选择 Node Audio Send / BlackHole 虚拟输出设备');
  // Bluetooth reconnection can replace the default microphone between calls.
  const status = await command('audio/prepare', { input: expected === 'Node Virtual Mic' ? 'node' : 'blackhole' });
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  if (!status.defaultInput?.includes(expected)) throw new Error(`未能准备 ${expected} 输入设备`);
  const wecom = status.processes?.find((process: { bundle: string; inputActive: boolean }) => process.bundle === 'com.tencent.WeWorkMac' && process.inputActive);
  if (wecom?.input?.length && !wecom.input.includes(expected)) throw new Error(`企微当前麦克风是 ${wecom.input.join(' / ')}，请在企微通话设备中选择 ${expected}`);
  const context: SinkContext = new AudioContext({ sampleRate: 48000 });
  const analyser = context.createAnalyser(); analyser.fftSize = 2048;
  let oscillator: OscillatorNode | undefined, toneGain: GainNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined, timer: ReturnType<typeof setInterval> | undefined, closed = false;
  function close() {
    if (closed) return;
    closed = true; signal.removeEventListener('abort', close); clearInterval(timer);
    oscillator?.stop(); oscillator?.disconnect(); toneGain?.disconnect();
    source?.disconnect(); analyser.disconnect(); void context.close();
  }
  async function resume() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([context.resume(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('浏览器未允许自动音频，请点击“启用企微声音”')), 4000);
      })]);
    } finally { clearTimeout(timeout); }
    if (closed) throw new DOMException('aborted', 'AbortError');
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (!context.setSinkId) throw new Error('当前浏览器不支持虚拟音频输出，请使用新版 Chrome');
    await context.setSinkId(sink);
    if (closed) throw new DOMException('aborted', 'AbortError');
    // The only audible connection is the explicitly selected virtual output.
    analyser.connect(context.destination);
    await resume();
    const samples = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0, peak = 0;
      for (const sample of samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const db = (value: number) => Math.max(-96, 20 * Math.log10(value || 1e-8));
      onLevel({ rms: db(Math.sqrt(sum / samples.length)), peak: db(peak), received: !!source || !!oscillator });
    }, 200);
    return {
      async attach(stream: MediaStream) {
        if (closed) return;
        source?.disconnect(); source = context.createMediaStreamSource(stream); source.connect(analyser);
        onLevel({ rms: -96, peak: -96, received: true });
        await resume();
      },
      async testTone() {
        if (closed) return;
        await resume();
        oscillator = context.createOscillator(); toneGain = context.createGain();
        oscillator.frequency.value = 440; toneGain.gain.value = .08;
        oscillator.connect(toneGain); toneGain.connect(analyser);
        oscillator.start();
        await new Promise<void>(resolve => {
          oscillator!.onended = () => { oscillator?.disconnect(); toneGain?.disconnect(); oscillator = undefined; toneGain = undefined; resolve(); };
          oscillator!.stop(context.currentTime + 3);
        });
      },
      resume, close,
    };
  } catch (error) { close(); throw error; }
}
