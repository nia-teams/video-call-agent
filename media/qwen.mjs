import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { localHost, sameOrigin } from './bridge.mjs';

import { SESSION, configuration } from './qwen-config.mjs';
export { DEFAULT_MODEL, SESSION, configuration } from './qwen-config.mjs';
export function confirmed(session, { model, voice }) {
  return session?.model === model && session?.modalities?.includes('audio') && session?.modalities?.includes('text') &&
    ['input', 'output'].every(side => session.audio?.[side]?.format?.type === 'pcm' && session.audio[side].format.sample_rate === SESSION.audio[side].format.sample_rate) &&
    session.audio.output.voice === voice && Object.entries(SESSION.turn_detection).every(([k, v]) => session.turn_detection?.[k] === v);
}
// Native capture is 48 kHz stereo Float32LE; preserve the 3-frame phase
// between packets and average before 3:1 decimation (no packet-edge drift).
export function createDownsampler() {
  let count = 0, sum = 0;
  return bytes => {
    if (!bytes.length || bytes.length % 8) throw new Error('Invalid capture PCM');
    const out = Buffer.alloc(Math.ceil(bytes.length / 24) * 2); let offset = 0;
    for (let i = 0; i < bytes.length; i += 8) {
      const a = bytes.readFloatLE(i), b = bytes.readFloatLE(i + 4);
      sum += (Number.isFinite(a) ? a : 0) / 2 + (Number.isFinite(b) ? b : 0) / 2;
      if (++count === 3) { out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sum / 3)) * 32767), offset); offset += 2; count = 0; sum = 0; }
    }
    return out.subarray(0, offset);
  };
}
export function createQwen({ bridge, env = process.env, configurationError, onStatus = () => {}, connect = (url, options) => new WebSocket(url, options) }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64000 });
  let active = null;
  const sessions = new Set();
  function upgrade(req, socket, head) {
    if (req.url?.split('?')[0] !== '/bridge/qwen') return false;
    if (!localHost(req.headers.host) || !sameOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') { socket.destroy(); return true; }
    wss.handleUpgrade(req, socket, head, client => open(client, req)); return true;
  }
  function open(client, req) {
    let upstream, source, ready = false, initialized = false, closed = false;
    let turn = 0, speechItem = '', speaking = false, committedTurn = -1, requestedTurn = -1, inFlight = null, drainTimer;
    const rejectedResponses = new Set();
    // Fixed-size numeric projection only: never retain PCM, transcript, IDs,
    // endpoint, config, provider payloads or raw errors in diagnostics.
    const diagnostics = { phase: 'connecting', inputPackets: 0, inputBytes: 0, inputRms: 0,
      speechStarted: 0, speechStopped: 0, committed: 0, responseRequested: 0,
      responseCreated: 0, audioBytes: 0, responseDone: 0, videoFrames: 0, videoBytes: 0, videoSkipped: 0 };
    let signalSquares = 0, signalSamples = 0;
    const report = () => {
      diagnostics.inputRms = signalSamples ? Math.sqrt(signalSquares / signalSamples) : 0;
      signalSquares = 0; signalSamples = 0;
      send({ type: 'diagnostics', ...diagnostics });
    };
    // Packet hot paths mutate numbers only; at most one periodic UI update/s.
    const diagnosticTimer = setInterval(report, 1000);
    let videoBusy = false;
    const videoTimer = setInterval(async () => {
      // Audio must precede images. Only the selected WeCom capture is shared;
      // microphone mode never captures or forwards a camera implicitly.
      if (closed || !ready || source !== 'wecom' || !diagnostics.inputPackets || videoBusy) return;
      const frame = bridge.incomingFrame?.();
      if (!frame) return;
      if (upstream.bufferedAmount > 128000) { diagnostics.videoSkipped++; return; }
      videoBusy = true;
      try {
        const jpeg = await sharp(frame, { limitInputPixels: 1920 * 1920 }).resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 65 }).toBuffer();
        if (closed || !ready || !bridge.captureReady()) return;
        const image = jpeg.toString('base64');
        if (image.length > 256 * 1024) { diagnostics.videoSkipped++; return; }
        if (provider('input_image_buffer.append', { image })) { diagnostics.videoFrames++; diagnostics.videoBytes += jpeg.length; }
      } catch { if (!closed) diagnostics.videoSkipped++; }
      finally { videoBusy = false; }
    }, 1000);
    let lastInput = Date.now();
    const downsample = createDownsampler();
    const send = event => { if (client.readyState === WebSocket.OPEN) { if (client.bufferedAmount > 256000) stop('Qwen playback too slow'); else client.send(JSON.stringify(event)); } };
    const timer = setTimeout(() => stop('Qwen initialization timed out'), 20000);
    const watchdog = setInterval(() => {
      if (ready && ((source === 'wecom' && !bridge.captureReady()) || Date.now() - lastInput > 5000)) stop('Qwen input stopped');
    }, 1000);
    function stop(error) {
      if (closed) return; closed = true; clearTimeout(timer); clearTimeout(drainTimer); clearInterval(watchdog); clearInterval(diagnosticTimer); clearInterval(videoTimer);
      diagnostics.phase = error ? 'failed' : 'closed'; report();
      // Reasons originate in this module; arbitrary configuration/provider errors
      // never enter the local operational log.
      onStatus({ phase: diagnostics.phase, reason: configurationError && error === configurationError ? 'configuration-error' : error || '', inputPackets: diagnostics.inputPackets, audioBytes: diagnostics.audioBytes });
      sessions.delete(stop);
      if (active?.client === client) active = null;
      if (error) send({ type: 'error', message: error });
      // terminate also aborts an in-flight handshake; no provider retries.
      upstream?.terminate(); client.close();
      const kill = setTimeout(() => client.terminate(), 1000); kill.unref(); client.once('close', () => clearTimeout(kill));
    }
    function provider(type, data = {}) {
      if (!upstream || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 128000) { stop('Qwen upstream unavailable'); return; }
      upstream.send(JSON.stringify({ event_id: randomUUID(), type, ...data }));
      return true;
    }
    // Exactly one host-requested response can be unresolved at a time. A new
    // committed turn waits for the interrupted response's terminal event; thus
    // even a response.created delayed beyond the new commit still belongs to
    // the old request, never to the new turn.
    function requestResponse() {
      if (closed || inFlight || speaking || committedTurn !== turn || requestedTurn === turn) return;
      committedTurn = -1; requestedTurn = turn;
      inFlight = { turn, id: '', cancelSent: false };
      if (provider('response.create')) diagnostics.responseRequested++;
    }
    function cancelResponse() {
      if (!inFlight) return;
      if (!drainTimer) drainTimer = setTimeout(() => stop('Qwen interrupted response did not finish'), 5000);
      if (inFlight.id && !inFlight.cancelSent) {
        rejectedResponses.add(inFlight.id); inFlight.cancelSent = true;
        provider('response.cancel', { response_id: inFlight.id });
      }
    }
    function input(bytes) {
      if (!ready || closed || !bytes.length) return;
      lastInput = Date.now();
      for (let i = 0; i < bytes.length; i += 6400) {
        const packet = bytes.subarray(i, i + 6400);
        if (!provider('input_audio_buffer.append', { audio: packet.toString('base64') })) return;
        diagnostics.inputPackets++; diagnostics.inputBytes += packet.length;
        for (let j = 0; j < packet.length; j += 2) { const sample = packet.readInt16LE(j) / 32768; signalSquares += sample * sample; signalSamples++; }
      }
    }
    client.on('message', (raw, binary) => {
      try {
        if (binary) {
          if (!ready || source !== 'microphone' || !raw.length || raw.length % 2 || raw.length > 16000) return stop('Invalid Qwen input');
          input(raw); return;
        }
        if (initialized) return stop('Invalid Qwen control');
        initialized = true;
        const init = JSON.parse(raw.toString());
        if (!bridge.authorize(req, init.token) || !['wecom', 'microphone'].includes(init.source)) return stop('Qwen authorization rejected');
        if (active) return stop('Another Qwen session is active');
        if (init.source === 'wecom' && !bridge.captureReady()) return stop('Start WeCom capture first');
        if (configurationError) return stop(configurationError);
        let config;
        try { config = configuration(env); }
        catch { return stop('Qwen 未配置或配置无效：请检查 .env 中的 Qwen 配置。'); }
        source = init.source; active = { client, input: bytes => { if (source === 'wecom') input(downsample(bytes)); }, stop };
        onStatus({ phase: 'connecting' });
        upstream = connect(config.url, { headers: { Authorization: `Bearer ${config.key}` }, followRedirects: false, handshakeTimeout: 15000, maxPayload: 1048576 });
        upstream.on('error', () => stop('Qwen connection failed'));
        upstream.on('close', () => stop('Qwen connection closed'));
        upstream.on('message', raw => {
          if (closed) return;
          try {
            const event = JSON.parse(raw.toString());
            if (event.type === 'session.created') {
              provider('session.update', { session: {
                ...SESSION, audio: { ...SESSION.audio, output: { ...SESSION.audio.output, voice: config.voice } },
                ...(config.instructions ? { instructions: config.instructions } : {}),
              } });
            } else if (event.type === 'session.updated') {
              if (!confirmed(event.session, config) || (config.instructions && event.session.instructions !== config.instructions)) return stop('Qwen session configuration not confirmed');
              diagnostics.phase = 'ready'; ready = true; lastInput = Date.now(); clearTimeout(timer); send({ type: 'ready' });
              onStatus({ phase: 'ready' });
            } else if (event.type === 'error') stop('Qwen provider rejected the session');
            else if (ready && event.type === 'input_audio_buffer.speech_started') {
              if (typeof event.item_id !== 'string' || !event.item_id) return stop('Qwen speech identity missing');
              if (event.item_id === speechItem) return;
              diagnostics.speechStarted++;
              turn++; speechItem = event.item_id; speaking = true; committedTurn = -1;
              cancelResponse(); send({ type: 'clear' });
            } else if (ready && event.type === 'input_audio_buffer.speech_stopped' && event.item_id === speechItem) {
              diagnostics.speechStopped++; speaking = false; requestResponse();
            } else if (ready && event.type === 'input_audio_buffer.committed' && event.item_id === speechItem) {
              diagnostics.committed++; committedTurn = turn; requestResponse();
            } else if (ready && event.type === 'response.created') {
              const id = event.response?.id;
              if (rejectedResponses.has(id)) return;
              if (typeof id !== 'string' || !id || !inFlight || inFlight.id) return stop('Unexpected Qwen response identity');
              diagnostics.responseCreated++; inFlight.id = id;
              if (inFlight.turn !== turn) cancelResponse();
            } else if (ready && ['response.audio.delta', 'response.output_audio.delta'].includes(event.type) && inFlight?.id && inFlight.turn === turn && !rejectedResponses.has(event.response_id) && event.response_id === inFlight.id) {
              if (typeof event.delta !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) return stop('Invalid Qwen audio');
              const pcm = Buffer.from(event.delta, 'base64');
              if (!pcm.length || pcm.length % 2 || pcm.length > 96000) return stop('Invalid Qwen audio');
              diagnostics.audioBytes += pcm.length;
              // Split into <=100 ms chunks for existing avatar PCM boundary.
              for (let i = 0; i < pcm.length; i += 4800) send({ type: 'audio', pcm: pcm.subarray(i, i + 4800).toString('base64') });
            } else if (ready && event.type === 'response.done' && inFlight?.id && event.response?.id === inFlight.id) {
              diagnostics.responseDone++; rejectedResponses.add(inFlight.id); inFlight = null;
              clearTimeout(drainTimer); drainTimer = undefined;
              if (rejectedResponses.size > 1024) return stop('Qwen session response limit reached');
              requestResponse();
            }
          } catch { stop('Invalid Qwen provider event'); }
        });
      } catch { stop('Qwen configuration or request invalid'); }
    });
    sessions.add(stop);
    client.on('error', () => stop()); client.on('close', () => stop());
  }
  return { upgrade, incoming(bytes) { active?.input(bytes); }, close() { for (const stop of sessions) stop(); for (const client of wss.clients) client.terminate(); wss.close(); } };
}
