export function decodePcm(packet: { pcm?: unknown; sampleRate?: unknown; channels?: unknown }): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  if (packet.sampleRate !== 48000 || packet.channels !== 2 || typeof packet.pcm !== 'string' || packet.pcm.length > 256000) throw new Error('Invalid PCM format');
  const bytes = Uint8Array.from(atob(packet.pcm), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length % 8) throw new Error('Invalid PCM length');
  const samples = new DataView(bytes.buffer), frames = bytes.length / 8;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < 2; ch++) {
    const value = samples.getFloat32(i * 8 + ch * 4, true);
    (ch ? right : left)[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }
  return [left, right];
}
