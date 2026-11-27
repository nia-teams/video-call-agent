import { createLiveCanvasRelay } from './live-canvas.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile, stat, rename, readFile, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecordings, recordingInput } from './recordings.mjs';
import { createAvatarRelay, serveAvatarAsset } from './avatar.mjs';

export const localHost = host => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '');
export function sameOrigin(req) {
  try { const u = new URL(req.headers.origin); const host = new URL(`http://${req.headers.host}`); return u.protocol === 'http:' && localHost(u.host) && u.hostname === host.hostname && (u.host === host.host || !u.port); } catch { return false; }
}
export async function body(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('请求内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function byteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw new Error('Invalid range');
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw new Error('Invalid range');
  return { start, end };
}
export function captureIsFresh(state, now = Date.now()) {
  return state.capture.running && now - Math.max(state.lastVideo, state.lastAudio, state.capture.lastHeartbeat || 0) <= 8000;
}
export function createBridge({ directory, helper, port, onAvatarStart, onOutputPrepare, avatarNow, onIncomingAudio }) {
  const recordings = createRecordings(path.join(directory, 'recordings'));
  let inputChild = null, recordingEnabled = false, recordingCallID = '';
  function stopRecording() { if (inputChild) inputChild.kill('SIGTERM'); inputChild = null; return recordings.finish(); }
  const liveCanvas = createLiveCanvasRelay();
  const avatar = createAvatarRelay({ now: avatarNow });
  const avatarDirectory = new URL('./avatar-assets/', import.meta.url);
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const hasVideo = existsSync(path.join(directory, 'source.mp4'));
  const avatarChoice = path.join(directory, 'avatar-selected');
  const canvasChoice = path.join(directory, 'live-canvas-selected');
  const hasCanvas = existsSync(canvasChoice);
  const hasAvatar = !hasCanvas && existsSync(avatarChoice);
  const state = { source: { kind: hasCanvas ? 'live-canvas' : hasAvatar ? 'avatar' : hasVideo ? 'file' : 'idle', url: !hasCanvas && !hasAvatar && hasVideo ? '/bridge/file' : '', revision: hasCanvas || hasAvatar || hasVideo ? 1 : 0, playing: hasCanvas || hasAvatar || hasVideo, startedAt: Date.now(), loop: true }, capture: { running: false, error: '', windowID: null }, frames: { incoming: 0, outgoing: 0 }, audio: { incoming: 0, outgoing: 0 }, lastVideo: 0, lastAudio: 0 };
  async function selectAvatar() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await unlink(canvasChoice).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(avatarChoice, '', { mode: 0o600 });
    if (state.source.kind !== 'avatar') state.source = { kind: 'avatar', url: '', revision: state.source.revision + 1, playing: true, startedAt: Date.now(), loop: true };
  }
  const latest = { incoming: null, outgoing: null };
  const viewers = { incoming: new Set(), outgoing: new Set() };
  const listeners = { incoming: new Set(), outgoing: new Set() };
  let child = null, captureRun = 0, listing = false;
  const json = (res, value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const validToken = req => {
    const a = Buffer.from(req.headers.authorization || ''), b = Buffer.from(`Bearer ${token}`);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  function stopCapture() { captureRun++; if (child) child.kill('SIGTERM'); child = null; state.capture.running = false; state.capture.windowID = null; latest.incoming = null; }
  function packet(channel, bytes) {
    latest[channel] = bytes; state.frames[channel]++; if (channel === 'incoming') state.lastVideo = Date.now();
    for (const res of viewers[channel]) {
      if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); continue; }
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`); res.write(bytes); res.write('\r\n');
    }
  }
  function audio(channel, bytes) {
    if (!bytes.length || bytes.length % 8 || bytes.length > 192000) throw new Error('PCM 必须是 48kHz 双声道交错 Float32，小端，每包不超过 0.5 秒');
    if (channel === 'incoming') { recordings.packet('incoming', bytes); onIncomingAudio?.(bytes); }
    state.audio[channel]++; if (channel === 'incoming') state.lastAudio = Date.now();
    const data = `data: ${JSON.stringify({ pcm: bytes.toString('base64'), sampleRate: 48000, channels: 2 })}\n\n`;
    for (const res of listeners[channel]) { if (res.writableLength > 512000) res.destroy(); else res.write(data); }
  }
  const heartbeat = setInterval(() => { for (const set of Object.values(listeners)) for (const res of set) res.write(': keepalive\n\n'); }, 15000);
  heartbeat.unref();
  async function nativeList() {
    if (!existsSync(helper)) throw new Error('原生采集组件未编译，请运行媒体控制台启动脚本');
    if (listing) throw new Error('窗口列表读取中');
    listing = true;
    try {
      return await new Promise((resolve, reject) => {
        const proc = spawn(helper, ['--list'], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
        const timer = setTimeout(() => { proc.kill(); reject(new Error('读取窗口超时，请检查屏幕录制权限')); }, 20000);
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.stdout.on('data', d => { if (out.length < 128000) out += d; });
        proc.stderr.on('data', d => { if (err.length < 2000) err += d; });
        proc.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(err || '无法读取窗口')); else { try { resolve(JSON.parse(out)); } catch { reject(new Error('窗口列表格式错误')); } } });
      });
    } finally { listing = false; }
  }
  async function audioProbe(action = '') {
    const probe = path.join(path.dirname(helper), 'AudioProbe');
    if (!existsSync(probe)) throw new Error('音频诊断组件未编译，请重新运行启动脚本');
    const {stdout} = await promisify(execFile)(probe, action ? [action] : [], {timeout:12000,maxBuffer:128000});
    return JSON.parse(stdout);
  }
  function recordingStatus() { return { enabled: recordingEnabled, ...recordings.status() }; }
  async function startRecording(callID) {
    if (!recordingEnabled) return;
    if (recordings.status().active?.callID === callID) return;
    if (!existsSync(helper)) throw new Error('请重新编译原生采集组件');
    stopRecording();
    const id = recordings.start(callID);
    let selected;
    try { selected = recordingInput(await audioProbe()); }
    catch (error) { selected = { name: '', warning: `输入设备诊断失败：${error.message}；本次保留企微播放音轨` }; }
    // A call may end while CoreAudio is responding. Never start a late reader.
    if (recordings.status().active?.id !== id) return;
    recordings.input(selected.name);
    if (selected.warning) recordings.fail(selected.warning);
    if (!selected.name) return;
    const proc = spawn(helper, ['--record-input', `http://127.0.0.1:${port}`, selected.name, id], { stdio: ['pipe', 'ignore', 'pipe'] });
    inputChild = proc; proc.stdin.end(token + '\n');
    proc.stderr.on('data', d => { if (inputChild === proc) recordings.fail(d.toString().slice(-1000)); });
    proc.on('error', e => { if (inputChild === proc) { recordings.fail(e.message); inputChild = null; } });
    proc.on('exit', () => { if (inputChild === proc) { recordings.fail(recordings.status().error || '本方输入采集已中断；继续保存企微播放音轨'); inputChild = null; } });
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/bridge/')) return false;
    // Bound to loopback, with Host + Origin / Fetch Metadata checks to prevent
    // another website from operating capture or reading live call media.
    if (!localHost(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, { error: 'Local access only' }, 403); return true; }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const native = url.pathname.startsWith('/bridge/ingest/');
    if (native ? !validToken(req) : req.method !== 'GET' && (!sameOrigin(req) || req.headers['x-studio-token'] !== csrfToken)) { json(res, { error: 'Origin or token rejected' }, 403); return true; }
    try {
      const p = url.pathname;
      if (req.method === 'GET' && p === '/bridge/state') {
        let autoAudio = null, autoCall = null;
        try {
          const status = JSON.parse(await readFile(path.join(directory, 'auto-audio.json'), 'utf8'));
          if (Number.isInteger(status.pid) && Date.now() - status.updatedAt < 8000 && Date.now() >= status.updatedAt) {
            process.kill(status.pid, 0);
            autoAudio = { active: status.active === true, message: String(status.message || '').slice(0, 300) };
            if(status.autoCall && ['waiting','capturing','ready','ended','error'].includes(status.autoCall.phase)) {
              autoCall={id:String(status.autoCall.id||'').slice(0,80),phase:status.autoCall.phase,message:String(status.autoCall.message||'').slice(0,500),windowID:Number.isSafeInteger(status.autoCall.windowID)?status.autoCall.windowID:null};
            }
          }
        } catch {}
        json(res, { ...state, recordings: recordingStatus(), avatar: avatar.status(), service: 'video-call-agent', protocolVersion: 7, autoAudio, autoCall, csrfToken, nativeReady: existsSync(helper), blackHoleInstalled: existsSync('/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver') });
      }
      else if (req.method === 'GET' && p === '/bridge/live-canvas/events') { liveCanvas.subscribe(req, res); }
      else if (req.method === 'POST' && p === '/bridge/live-canvas') {
        const input = JSON.parse((await body(req, 1024 * 1024)).toString());
        if (state.source.kind !== 'live-canvas' || input.sourceRevision !== state.source.revision) { json(res, { error: 'live-canvas 视频源已切换' }, 409); return true; }
        liveCanvas.publish(input.frame);
        json(res, { accepted: true });
      }
      else if (req.method === 'GET' && p === '/bridge/avatar/events') { avatar.subscribe(req, res); }
      else if (req.method === 'POST' && p === '/bridge/avatar') {
        const input = JSON.parse((await body(req, 4096)).toString());
        const wasActive = avatar.active();
        const result = avatar.control(input);
        if (result.active && input.action === 'start' && !input.resume) await selectAvatar();
        // A call starts mouth analysis on the already-rendered source. The
        // callback must not reload CEF, resize the canvas or reset the camera.
        if (!wasActive && result.active && input.action === 'start' && onAvatarStart) void Promise.resolve().then(onAvatarStart).catch(error => console.error(`OBS 人物输出准备失败：${error.message}`));
        json(res, result);
      }
      else if (req.method === 'POST' && p === '/bridge/avatar/pcm') { avatar.pcm(JSON.parse((await body(req, 64000)).toString())); json(res, { accepted: true }); }
      else if (req.method === 'POST' && p === '/bridge/recordings/settings') {
        const input = JSON.parse((await body(req, 4096)).toString());
        if (typeof input.enabled !== 'boolean') throw new Error('请选择是否开启通话录音');
        recordingEnabled = input.enabled;
        if (!recordingEnabled) stopRecording();
        else if (recordingCallID) await startRecording(recordingCallID);
        json(res, recordingStatus());
      }
      else if (req.method === 'POST' && p === '/bridge/recordings/start') {
        const input = JSON.parse((await body(req, 4096)).toString());
        if (typeof input.callID !== 'string' || !input.callID || input.callID.length > 100) throw new Error('缺少通话标识');
        recordingCallID = input.callID;
        await startRecording(input.callID);
        json(res, recordings.status());
      }
      else if (req.method === 'POST' && p === '/bridge/recordings/stop') {
        const input = JSON.parse((await body(req, 4096)).toString());
        if (!input.callID || recordingCallID === input.callID) { recordingCallID = ''; stopRecording(); }
        json(res, recordings.status());
      }
      else if (req.method === 'POST' && p === '/bridge/recordings/delete') {
        const input = JSON.parse((await body(req, 4096)).toString());
        json(res, { deleted: recordings.remove(input.id) });
      }
      else if (req.method === 'POST' && p === '/bridge/ingest/recording/input') {
        const bytes = await body(req, 192000);
        if (url.searchParams.get('id') === recordings.status().active?.id) recordings.packet('input', bytes);
        json(res, { accepted: true });
      }
      else if (req.method === 'GET' && /^\/bridge\/recordings\/[a-f0-9-]+\.wav$/.test(p)) {
        const id = p.split('/').at(-1).slice(0, -4), file = recordings.file(id);
        if (!file) { json(res, { error: '录音不存在' }, 404); return true; }
        const info = await stat(file); let range;
        try { range = byteRange(req.headers.range, info.size); } catch { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Length': range ? range.end - range.start + 1 : info.size, ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="wecom-${id}.wav"` } : {}), ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
        const stream = createReadStream(file, range || undefined); stream.on('error', () => res.destroy()); stream.pipe(res); res.on('close', () => stream.destroy());
      }
      else if (req.method === 'POST' && p === '/bridge/windows') { json(res, await nativeList()); }
      else if (req.method === 'POST' && p === '/bridge/audio/status') { json(res, await audioProbe()); }
      else if (req.method === 'POST' && p === '/bridge/audio/prepare') {
        const input = JSON.parse((await body(req, 4096)).toString() || '{}');
        if (input.input !== undefined && !['node', 'blackhole'].includes(input.input)) throw new Error('不支持的虚拟输入设备');
        await audioProbe('--repair-output');
        json(res, await audioProbe(input.input === 'node' ? '--select-node-mic' : input.input === 'blackhole' ? '--select-blackhole' : '--prepare-virtual'));
      }
      else if (req.method === 'POST' && p === '/bridge/audio/restore') { json(res, await audioProbe('--restore-microphone')); }
      else if (req.method === 'POST' && p === '/bridge/capture/start') {
        const input = JSON.parse((await body(req)).toString());
        if (!Number.isSafeInteger(input.windowID) || input.windowID <= 0) throw new Error('请选择企微窗口');
        if (!existsSync(helper)) throw new Error('原生组件尚未编译');
        stopCapture(); const run = captureRun;
        state.capture.error = ''; state.lastAudio = 0; state.lastVideo = 0; state.capture.lastHeartbeat = 0;
        state.capture.windowID = input.windowID;
        const proc = spawn(helper, ['--capture', String(input.windowID), `http://127.0.0.1:${port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
        child = proc; proc.stdin.end(token + '\n');
        let output='';
        proc.stdout.on('data', d => {
          if(run!==captureRun)return;
          output+=d.toString();let end;
          while((end=output.indexOf('\n'))>=0){const line=output.slice(0,end).trim();output=output.slice(end+1);if(line==='CAPTURE_READY')state.capture.running=true;if(line==='CAPTURE_READY'||line==='CAPTURE_HEARTBEAT')state.capture.lastHeartbeat=Date.now();}
          if(output.length>16384)output='';
        });
        proc.stderr.on('data', d => { if (run === captureRun) state.capture.error = d.toString().slice(-1800); });
        proc.on('error', e => { if (run === captureRun) { state.capture.error = e.message; state.capture.running = false; recordingCallID = ''; stopRecording(); } });
        proc.on('exit', code => { if (run === captureRun) { state.capture.running = false; child = null; recordingCallID = ''; stopRecording(); if (code && !state.capture.error) state.capture.error = `采集组件退出：${code}`; } });
        json(res, { requested: true });
      }
      else if (req.method === 'POST' && p === '/bridge/capture/stop') { recordingCallID = ''; stopRecording(); stopCapture(); json(res, { stopped: true }); }
      else if (req.method === 'POST' && p === '/bridge/source') {
        const input = JSON.parse((await body(req)).toString());
        if (!['idle', 'file', 'url', 'live', 'avatar', 'live-canvas'].includes(input.kind)) throw new Error('不支持的视频来源');
        if (input.kind === 'url') { const u = new URL(input.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只支持 HTTP(S) 视频直链'); }
        if (input.kind === 'file' && !existsSync(path.join(directory, 'source.mp4'))) throw new Error('请先上传视频');
        if (input.kind === 'avatar') {
          await selectAvatar();
          if (onOutputPrepare) void Promise.resolve().then(onOutputPrepare).catch(error => console.error(`OBS 人物输出准备失败：${error.message}`));
          json(res, state.source); return true;
        }
        await unlink(avatarChoice).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (input.kind === 'live-canvas') {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(canvasChoice, '', { mode: 0o600 });
          liveCanvas.publish(null);
          if (onOutputPrepare) void Promise.resolve().then(onOutputPrepare).catch(error => console.error(`OBS 画板输出准备失败：${error.message}`));
        } else await unlink(canvasChoice).catch(error => { if (error.code !== 'ENOENT') throw error; });
        state.source = { kind: input.kind, url: input.kind === 'file' ? '/bridge/file' : input.kind === 'url' ? String(input.url).slice(0, 4096) : '', revision: state.source.revision + 1, playing: input.playing !== false, startedAt: Date.now(), loop: input.loop !== false };
        json(res, state.source);
      }
      else if (req.method === 'POST' && p === '/bridge/upload') {
        // One raw video upload, no user-controlled filenames or executable files.
        if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(req.headers['content-type'])) throw new Error('仅支持 MP4、WebM、MOV 视频');
        const bytes = await body(req, 256 * 1024 * 1024);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temp = path.join(directory, `upload-${randomBytes(6).toString('hex')}`);
        await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path.join(directory, 'source.mp4'));
        await unlink(avatarChoice).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await unlink(canvasChoice).catch(error => { if (error.code !== 'ENOENT') throw error; });
        state.source = { kind: 'file', url: '/bridge/file', revision: state.source.revision + 1, playing: true, startedAt: Date.now(), loop: true };
        json(res, { bytes: bytes.length });
      }
      else if (req.method === 'GET' && p === '/bridge/file') {
        const file = path.join(directory, 'source.mp4'); const info = await stat(file);
        let range; try { range = byteRange(req.headers.range, info.size); } catch { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Length': range ? range.end - range.start + 1 : info.size, ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
        const stream = createReadStream(file, range || undefined); stream.on('error', () => res.destroy()); stream.pipe(res); res.on('close', () => stream.destroy());
      }
      else if (req.method === 'GET' && p === '/bridge/snapshot/incoming') {
        if (!latest.incoming || !captureIsFresh(state)) {
          json(res, { error: '企微画面尚未就绪或已中断' }, 503);
        } else {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Time': String(state.lastVideo) });
          res.end(latest.incoming);
        }
      }
      else if (req.method === 'GET' && /^\/bridge\/video\/(incoming|outgoing)$/.test(p)) {
        const channel = p.split('/').at(-1);
        if (viewers[channel].size >= 8) throw new Error('观看连接过多');
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' }); res.flushHeaders();
        viewers[channel].add(res); req.on('close', () => viewers[channel].delete(res));
        if (latest[channel]) { const bytes = latest[channel]; res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`); res.write(bytes); res.write('\r\n'); }
      }
      else if (req.method === 'GET' && /^\/bridge\/audio\/(incoming|outgoing)$/.test(p)) {
        const channel = p.split('/').at(-1);
        if (listeners[channel].size >= 8) throw new Error('音频连接过多');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
        listeners[channel].add(res); req.on('close', () => listeners[channel].delete(res));
      }
      else if (req.method === 'POST' && /^\/bridge\/(ingest\/)?frame\/(incoming|outgoing)$/.test(p)) {
        const channel = p.split('/').at(-1); if (channel === 'incoming' && !native) throw new Error('企微画面只能由原生采集组件提交');
        const bytes = await body(req, 2 * 1024 * 1024);
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('需要有效 JPEG 帧');
        packet(channel, bytes); json(res, { accepted: true });
      }
      else if (req.method === 'POST' && /^\/bridge\/(ingest\/)?pcm\/(incoming|outgoing)$/.test(p)) {
        const channel = p.split('/').at(-1); if (channel === 'incoming' && !native) throw new Error('企微音频只能由原生采集组件提交');
        audio(channel, await body(req, 192000)); json(res, { accepted: true });
      }
      // Asset paths share the avatar prefix with the explicit relay endpoints above.
      else if (!await serveAvatarAsset(req, res, p, fileURLToPath(avatarDirectory))) json(res, { error: 'Not found' }, 404);
    } catch (e) { if (url.pathname === '/bridge/recordings/start') recordings.fail(e.message); if (!res.headersSent) json(res, { error: e.message || '请求失败' }, 400); else res.destroy(); }
    return true;
  }
  return { handle, incomingFrame() { return captureIsFresh(state) ? latest.incoming : null; }, authorize(req, value) { return sameOrigin(req) && value === csrfToken; }, captureReady() { return captureIsFresh(state); }, close() { liveCanvas.close(); avatar.close(); stopRecording(); stopCapture(); clearInterval(heartbeat); for (const set of [...Object.values(viewers), ...Object.values(listeners)]) for (const res of set) res.destroy(); } };
}
