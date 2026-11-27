import { mkdirSync, openSync, closeSync, writeSync, readSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const rate = 48000;
export function recordingInput(devices) {
  const processes = (devices.processes || []).filter(p => p.bundle.startsWith('com.tencent.WeWorkMac'));
  const active = [...new Set(processes.filter(p => p.inputActive).flatMap(p => p.input || []))];
  if (active.length === 1) return { name: active[0], warning: '' };
  const opened = [...new Set(processes.flatMap(p => p.input || []))];
  if (!active.length && opened.length === 1) return { name: opened[0], warning: '企微输入设备已打开，尚未报告活动状态' };
  const defaults = devices.defaultInput || [];
  if (defaults.length === 1 && /^(Node Virtual Mic|BlackHole)/.test(defaults[0])) {
    return { name: defaults[0], warning: '企微输入设备报告不明确，已采集当前配置的虚拟话筒；请核对双方声道' };
  }
  return { name: '', warning: '无法确认本方输入设备，本次仅录到企微播放音轨' };
}

export function wavHeader(bytes) {
  const b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
export function createRecordings(directory, now = Date.now) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let active = null, error = '';
  const entries = new Map();
  for (const name of readdirSync(directory)) if (/^[a-f0-9-]+\.json$/.test(name)) {
    try { const entry = JSON.parse(readFileSync(path.join(directory, name))); if (name === `${entry.id}.json`) entries.set(entry.id, entry); } catch {}
  }
  function finish() {
    if (!active) return null;
    const a = active; active = null;
    try {
      const frames = Math.max(1, Math.min(rate * 60 * 60 * 5, Math.max(Math.round((now() - a.startedAt) * rate / 1000), a.ends[0], a.ends[1])));
      const out = openSync(path.join(directory, `${a.id}.wav.part`), 'wx', 0o600);
      try {
        writeSync(out, wavHeader(frames * 4));
        for (let start = 0; start < frames; start += 16384) {
          const n = Math.min(16384, frames - start), channels = [Buffer.alloc(n * 2), Buffer.alloc(n * 2)], mixed = Buffer.alloc(n * 4);
          for (let ch = 0; ch < 2; ch++) readSync(a.files[ch], channels[ch], 0, n * 2, start * 2);
          for (let i = 0; i < n; i++) { mixed.writeInt16LE(channels[0].readInt16LE(i * 2), i * 4); mixed.writeInt16LE(channels[1].readInt16LE(i * 2), i * 4 + 2); }
          writeSync(out, mixed);
        }
      } finally { closeSync(out); }
      const entry = { id: a.id, callID: a.callID, startedAt: a.startedAt, duration: frames / rate, bytes: frames * 4 + 44, packets: a.packets, inputDevice: a.inputDevice, warning: [error, ...a.packets.map((n, i) => n ? '' : `${i === 0 ? '对方' : '本方'}音轨未收到采样`)].filter(Boolean).join('；') };
      renameSync(path.join(directory, `${a.id}.wav.part`), path.join(directory, `${a.id}.wav`));
      writeFileSync(path.join(directory, `${a.id}.json`), JSON.stringify(entry), { mode: 0o600 }); entries.set(a.id, entry); return entry;
    } catch (e) { error = `保存录音失败：${e.message}`; return null; }
    finally { a.files.forEach(closeSync); for (let i = 0; i < 2; i++) try { unlinkSync(path.join(directory, `${a.id}.${i}.pcm`)); } catch {} }
  }
  return {
    start(callID, inputDevice = '') {
      if (active?.callID === callID) return active.id;
      finish(); error = ''; const id = randomUUID(), files = [];
      try { for (let i = 0; i < 2; i++) files.push(openSync(path.join(directory, `${id}.${i}.pcm`), 'wx+', 0o600)); }
      catch (e) { files.forEach(closeSync); throw e; }
      active = { id, callID, inputDevice, startedAt: now(), files, ends: [0, 0], packets: [0, 0] }; return id;
    },
    packet(channel, bytes) {
      if (!active) return;
      const a = active, ch = channel === 'incoming' ? 0 : 1, count = bytes.length / 8;
      if (!Number.isInteger(count) || !count || count > 24000) throw new Error('录音 PCM 格式错误');
      const start = Math.max(a.ends[ch], Math.round((now() - a.startedAt) * rate / 1000) - count, 0);
      if (start + count > rate * 60 * 60 * 5) { error = '录音达到 5 小时上限'; finish(); return; }
      const mono = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) { const v = (bytes.readFloatLE(i * 8) + bytes.readFloatLE(i * 8 + 4)) / 2; mono.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0)) * 32767), i * 2); }
      try { writeSync(a.files[ch], mono, 0, mono.length, start * 2); a.ends[ch] = start + count; a.packets[ch]++; }
      catch (e) { error = `写入录音失败：${e.message}`; finish(); }
    },
    input(name) { if (active) active.inputDevice = name; },
    fail(message) { error = message; }, finish,
    status() { return { active: active ? { id: active.id, callID: active.callID, startedAt: active.startedAt, packets: active.packets, inputDevice: active.inputDevice } : null, error, items: [...entries.values()].sort((a, b) => b.startedAt - a.startedAt) }; },
    remove(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('录音标识无效');
      if (active?.id === id) throw new Error('正在录音，请挂断并保存后再删除');
      if (!entries.has(id)) return false;
      // Only completed recordings in our index can be removed. Missing files
      // are tolerated so a repeated request or interrupted deletion can finish.
      for (const extension of ['wav', 'json']) {
        try { unlinkSync(path.join(directory, `${id}.${extension}`)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      entries.delete(id);
      return true;
    },
    file(id) { return entries.has(id) ? path.join(directory, `${id}.wav`) : null; },
  };
}
