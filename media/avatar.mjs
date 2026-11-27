import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Only public rig assets are exposed; never serve arbitrary project files.
export async function serveAvatarAsset(req, res, pathname, directory) {
  if (!pathname.startsWith('/bridge/her/')) return false;
  const name = pathname.slice('/bridge/her/'.length);
  const allowed = /^(rig\/index\.html|presence-motion\.js|speech-lipsync\.js|studio-output\.js|rig\/lib\/pixi\.min\.js|rig\/assets\/([a-z_]+\.png|layers\.json))$/.test(name);
  if (req.method !== 'GET' || !allowed) { res.writeHead(404); res.end(); return true; }
  try {
    const data = await readFile(path.join(directory, name));
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' }[path.extname(name)];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
  return true;
}

export function createAvatarRelay({ now = Date.now } = {}) {
  const viewers = new Set();
  let session = '', touched = 0, generation = 0;
  let reason = 'idle', startedAt = 0, packets = 0, viewerConnections = 0;
  const emit = value => {
    const event = `data: ${JSON.stringify(value)}\n\n`;
    for (const res of viewers) {
      if (res.writableLength > 128000) res.destroy(); else res.write(event);
    }
  };
  function active() {
    if (session && now() - touched > 10000) { session = ''; reason = 'heartbeat-expired'; emit({ type: 'reset', active: false }); }
    return !!session;
  }
  const timer = setInterval(() => { active(); }, 1000); timer.unref();
  return {
    active,
    status() { return { active: active(), reason, startedAt, lastActivityAt: touched, packets, viewers: viewers.size, viewerConnections }; },
    control(input) {
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(input.session || '') || !['start', 'ping', 'stop', 'clear'].includes(input.action)) throw new Error('人物会话参数无效');
      active();
      if (input.action === 'start') {
        if (session && session !== input.session) throw new Error('另一个 AI 会话正在使用人物');
        if (!Number.isSafeInteger(input.generation ?? 0) || (input.generation ?? 0) < 0) throw new Error('人物代次无效');
        if (session !== input.session) generation = input.generation ?? 0;
        session = input.session; touched = now(); startedAt = now(); reason = 'connected'; emit({ type: 'reset', active: true });
      } else if (session === input.session) {
        if (input.action === 'clear') {
          if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('人物代次无效');
          if (input.generation > generation) { generation = input.generation; touched = now(); emit({ type: 'reset', active: true }); }
        } else if (input.action === 'stop') { session = ''; reason = 'stopped'; emit({ type: 'reset', active: false }); }
        else touched = now();
      }
      return { active: active() && session === input.session };
    },
    pcm(input) {
      if (!active() || input.session !== session) throw new Error('人物会话已结束');
      // A late HTTP body from before clear must not reopen the mouth.
      if ((input.generation ?? 0) !== generation) return;
      if (![16000, 22050, 24000, 32000, 44100, 48000, 96000].includes(input.sampleRate) || typeof input.pcm !== 'string' || input.pcm.length > 48000) throw new Error('人物音频格式无效');
      const bytes = Buffer.from(input.pcm, 'base64');
      if (!bytes.length || bytes.length % 4 || bytes.length / 4 > input.sampleRate * 0.2) throw new Error('人物音频包过大或无效');
      touched = now(); packets++; emit({ type: 'pcm', pcm: bytes.toString('base64'), sampleRate: input.sampleRate });
    },
    subscribe(req, res) {
      if (viewers.size >= 8) throw new Error('人物观看连接过多');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'reset', active: active() })}\n\n`);
      viewerConnections++; viewers.add(res); res.on('close', () => viewers.delete(res));
    },
    close() { clearInterval(timer); for (const res of viewers) res.destroy(); viewers.clear(); },
  };
}
