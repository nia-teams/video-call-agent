import { decodePcm } from '../studio/relay-pcm';

/** Audio-only relay from the captured WeCom application to WebRTC. */
export async function createWecomAudioInput(onFailure: (message: string) => void, signal: AbortSignal) {
  const context = new AudioContext({ sampleRate: 48000 });
  const destination = context.createMediaStreamDestination();
  let events: EventSource | undefined, closed = false, until = 0;
  const nodes = new Set<AudioBufferSourceNode>();
  function close() {
    if (closed) return;
    closed = true; signal.removeEventListener('abort', close); events?.close();
    for (const node of nodes) { node.stop(); node.disconnect(); }
    nodes.clear(); destination.stream.getTracks().forEach(track => track.stop()); void context.close();
  }
  function fail(message: string) { if (!closed) { close(); onFailure(message); } }
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([context.resume(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('浏览器未允许自动音频，请点击“开始语音通话”启用企微转接')), 4000);
      })]);
    } finally { clearTimeout(timer); }
    if (closed) throw new DOMException('aborted', 'AbortError');
    events = new EventSource('/bridge/audio/incoming');
    events.onmessage = event => {
      if (closed) return;
      try {
        const channels = decodePcm(JSON.parse(event.data));
        if (until > context.currentTime + 0.35) return;
        const buffer = context.createBuffer(2, channels[0].length, 48000);
        channels.forEach((samples, index) => buffer.copyToChannel(samples, index));
        const node = context.createBufferSource(); node.buffer = buffer;
        node.connect(destination); nodes.add(node);
        node.onended = () => { nodes.delete(node); node.disconnect(); };
        until = Math.max(until, context.currentTime + 0.02);
        node.start(until); until += buffer.duration;
      } catch { fail('企微音频格式异常，已结束 Live Canvas 通话'); }
    };
    events.onerror = () => fail('企微音频流已中断，已结束 Live Canvas 通话');
    return { stream: destination.stream, close };
  } catch (error) { close(); throw error; }
}
