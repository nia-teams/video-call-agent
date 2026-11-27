import { isIP } from 'node:net';

export const DEFAULT_MODEL = 'qwen3.5-omni-flash-realtime';
export const SESSION = {
  modalities: ['text', 'audio'],
  audio: { input: { format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } },
    output: { format: { type: 'pcm', sample_rate: 24000 }, voice: 'Raymond' } },
  turn_detection: { type: 'semantic_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800, create_response: false, interrupt_response: false },
};
const unsafe = /[\s\p{Cc}\p{Cf}]/u;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const invalid = () => new Error('Qwen server configuration invalid');

function validHostname(hostname) {
  if (hostname.startsWith('[')) return isIP(hostname.slice(1, -1)) === 6;
  const name = hostname.replace(/\.$/, '');
  return name.length <= 253 && name.split('.').every(label => dnsLabel.test(label));
}

function settings(env) {
  const voice = env.QWEN_VOICE === undefined ? SESSION.audio.output.voice : env.QWEN_VOICE;
  const model = env.QWEN_REALTIME_MODEL === undefined ? '' : env.QWEN_REALTIME_MODEL;
  if (typeof voice !== 'string' || !voice || /[^a-zA-Z0-9_-]/.test(voice) ||
      typeof model !== 'string' || unsafe.test(model)) throw invalid();
  return { voice, model };
}

export function configuration(env = process.env, { optional = false } = {}) {
  const key = env.DASHSCOPE_API_KEY;
  const endpoint = env.QWEN_REALTIME_URL;
  const { voice, model: explicitModel } = settings(env);
  if (optional && !key && !endpoint) return;

  // Reject raw characters WHATWG URL would silently strip or normalize.
  const authority = typeof endpoint === 'string' && /^wss:\/\/([^/?#]+)/i.exec(endpoint)?.[1];
  if (typeof key !== 'string' || !key || /[^!-~]/.test(key) || !authority || authority.includes('@') ||
      unsafe.test(endpoint) || /[\\#]/.test(endpoint)) throw invalid();
  let url;
  try { url = new URL(endpoint); } catch { throw invalid(); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || !validHostname(url.hostname)) throw invalid();

  const models = url.searchParams.getAll('model');
  if (models.length > 1 || (models.length === 1 &&
      (!models[0] || unsafe.test(models[0]) || (explicitModel && explicitModel !== models[0])))) throw invalid();
  const model = models[0] ?? (explicitModel || DEFAULT_MODEL);
  if (!models.length) url.search += `${url.search ? '&' : '?'}${new URLSearchParams({ model })}`;
  return { url: url.href, key, voice, model, instructions: env.QWEN_INSTRUCTIONS };
}
