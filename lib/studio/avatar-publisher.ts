import { studioHeaders } from '../../app/studio/media';

export function createAvatarPublisher(warn: (message: string) => void, provider = 'AI') {
  const session = crypto.randomUUID();
  let active = false, closed = false, sending = false, warned = false;
  let renewing = false, generation = 0;
  let clearBarrier: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  async function post(route: string, data: object, closing = false) {
    const send = async (refresh = false): Promise<Response> => fetch(`/bridge/avatar${route}`, {
      method: 'POST', headers: await studioHeaders('application/json', refresh), body: JSON.stringify({ session, ...data }),
      signal: closing ? AbortSignal.timeout(3000) : AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      ...(closing ? { keepalive: true } : {}),
    });
    let response = await send();
    // A media-service restart rotates its token while RTC audio can remain alive.
    if (response.status === 403 && !closed) response = await send(true);
    if (!response.ok) throw new Error('人物输出服务不可用');
    return response.json() as Promise<{ active?: boolean }>;
  }
  const warning = () => { if (!closed && !warned) { warned = true; warn(`HeR 口型连接中断，正在自动恢复；声音仍由${provider}输出`); } };
  let starting: Promise<boolean> | undefined;
  async function renew(initial = false) {
    if (closed || renewing) return false;
    renewing = true;
    try {
      if (initial || !active) await post('', { action: 'start', generation, ...(!initial ? { resume: true } : {}) });
      else {
        const result = await post('', { action: 'ping' });
        if (!result.active && !closed) await post('', { action: 'start', generation, resume: true });
      }
      if (closed) return false;
      active = true; warned = false;
      return true;
    } catch { active = false; warning(); return false; }
    finally { renewing = false; }
  }
  return {
    start() {
      if (closed) return Promise.resolve(false);
      if (!timer) timer = setInterval(() => { void renew(); }, 3000);
      return starting ??= renew(true);
    },
    generation() { return generation; },
    clear() {
      if (closed) return Promise.resolve(false);
      const next = ++generation;
      // Do not abort and overtake an old request without a server fence: its
      // body may already be arriving. The relay rejects old generations even
      // if that POST completes after this clear. New PCM waits for this ACK.
      clearBarrier = post('', { action: 'clear', generation: next }).then(result => {
        if (result.active !== true) throw new Error('人物清空未确认');
        return true;
      }).catch(() => {
        if (!closed && next === generation) { active = false; warning(); }
        return false;
      });
      return clearBarrier;
    },
    samples(channels: Float32Array[], sampleRate: number, expectedGeneration = generation) {
      // Drop late packets rather than accumulating latency or retaining SDK buffers.
      if (expectedGeneration !== generation || !active || closed || sending || !channels.length || !channels[0].length) return;
      if (![16000,22050,24000,32000,44100,48000,96000].includes(sampleRate)) return;
      const available = Math.min(...channels.map(channel => channel.length));
      // SDK frame length is not a duration: 4096 samples at 16kHz is 256ms.
      // Keep the latest bounded analysis window instead of dropping every frame.
      const count = Math.min(available, Math.floor(sampleRate * 0.15), 8192);
      if (!count) return;
      const offset = available - count;
      const mono = new Float32Array(count);
      for (const channel of channels) for (let i = 0; i < count; i++) mono[i] += (Number.isFinite(channel[offset+i]) ? channel[offset+i] : 0) / channels.length;
      const bytes = new Uint8Array(mono.buffer);
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      sending = true;
      const current = generation;
      const send = () => {
        if (closed || current !== generation || !active) return;
        return post('/pcm', { pcm: btoa(binary), sampleRate, generation: current });
      };
      const result = clearBarrier ? clearBarrier.then(cleared => cleared ? send() : undefined) : send();
      void Promise.resolve(result).catch(() => { if (!closed && current === generation) { active = false; warning(); } }).finally(() => { sending = false; });
    },
    close() {
      if (closed) return;
      closed = true; active = false; clearInterval(timer); controller.abort();
      // A stop is also sent when start was in flight. The lease handles page/process loss.
      void Promise.resolve(starting).then(() => post('', { action: 'stop' }, true)).catch(() => {});
    },
  };
}
