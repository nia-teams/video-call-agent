import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configuration as qwenConfiguration } from './media/qwen-config.mjs';

export const envFile = new URL('./.env', import.meta.url);
// Only application settings are imported. Shell/Node/Next control variables
// cannot be injected through this file; launch modes belong to the scripts.
export const defaults = Object.freeze({
  PORT: '3070',
  STUDIO_AUTO_ANSWER: '1',
  STUDIO_AUTO_CAPTURE: '1',
  OBS_WEBSOCKET_URL: '',
  OBS_WEBSOCKET_PASSWORD: '',
  DASHSCOPE_API_KEY: '',
  QWEN_REALTIME_URL: '',
  QWEN_REALTIME_MODEL: '',
  QWEN_VOICE: 'Raymond',
  QWEN_INSTRUCTIONS: '',
  OPENAI_API_KEY: '',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_LIVE_MODEL: 'gpt-live-1',
  OPENAI_BACKEND_API_KEY: '',
  OPENAI_BACKEND_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_BACKEND_MODEL: 'gpt-4.1',
});

export class EnvError extends Error {}

export function validateEnv(env, { requireOBS = false } = {}) {
  const errors = [];
  if (!/^\d+$/.test(env.PORT) || Number(env.PORT) < 1024 || Number(env.PORT) > 65535) errors.push('PORT 必须是 1024..65535 的整数');
  for (const key of ['STUDIO_AUTO_ANSWER', 'STUDIO_AUTO_CAPTURE']) {
    if (!['0', '1'].includes(env[key])) errors.push(`${key} 必须为 0 或 1`);
  }
  if (requireOBS || env.OBS_WEBSOCKET_URL || env.OBS_WEBSOCKET_PASSWORD) {
    try {
      const url = new URL(env.OBS_WEBSOCKET_URL);
      if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    } catch { errors.push('OBS_WEBSOCKET_URL 必须为本机 ws:// 或 wss:// 地址（例如 ws://127.0.0.1:4455）'); }
    if (!env.OBS_WEBSOCKET_PASSWORD.trim() || /[\r\n]/.test(env.OBS_WEBSOCKET_PASSWORD)) errors.push('OBS_WEBSOCKET_PASSWORD 必须填写 OBS WebSocket 认证密码');
  }
  try { qwenConfiguration(env, { optional: true }); }
  catch { errors.push('Qwen 配置无效：DASHSCOPE_API_KEY 与不含凭据或片段的 wss:// QWEN_REALTIME_URL 必须成对填写；URL 中的 model 不可重复，且须与非空 QWEN_REALTIME_MODEL 一致；请核对密钥、模型和 QWEN_VOICE 格式'); }
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BACKEND_API_KEY']) {
    if (env[key] && (!env[key].trim() || /[\r\n]/.test(env[key]))) errors.push(`${key} 不能仅含空白或包含换行`);
  }
  for (const key of ['OPENAI_BASE_URL', 'OPENAI_BACKEND_BASE_URL']) {
    try {
      const url = new URL(env[key]);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { errors.push(`${key} 必须为不含账号、密码、查询参数或片段的 HTTP(S) 地址`); }
  }
  for (const key of ['OPENAI_LIVE_MODEL', 'OPENAI_BACKEND_MODEL']) {
    if (!env[key].trim() || /[\r\n]/.test(env[key])) errors.push(`${key} 不能为空或包含换行`);
  }
  if (errors.length) throw new EnvError(`.env 配置检查失败：\n- ${errors.join('\n- ')}\n请修改 .env（参考 .env.example）后重新启动。`);
  return env;
}

/** Always resolve relative to this module, including Finder launches. Never
 * evaluate shell expressions, interpolate secrets, or fall back to old files. */
export function loadEnv({ file = envFile, requireOBS = false } = {}) {
  let descriptor, parsed;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 65536) throw new Error();
    const bytes = readFileSync(descriptor);
    if (bytes.length > 65536) throw new Error();
    parsed = parseEnv(bytes.toString('utf8'));
  } catch {
    throw new EnvError('无法读取 .env：请从 .env.example 复制创建，确认是可读的普通文件且不超过 64 KiB。');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  // Do not echo untrusted names or values: even a malformed line can be a key.
  if (Object.keys(parsed).some(key => !Object.hasOwn(defaults, key))) throw new EnvError('.env 含有未知配置项，请对照 .env.example 检查名称。');
  const env = validateEnv({ ...defaults, ...parsed }, { requireOBS });
  // Explicit blanks also replace inherited variables and Next .env.local values.
  Object.assign(process.env, env);
  return env;
}

export function studioBase(env = process.env) {
  return `http://127.0.0.1:${env.PORT || defaults.PORT}`;
}

export function isMainModule(url) {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(url); }
  catch { return false; }
}

if (isMainModule(import.meta.url)) {
  try { loadEnv({ requireOBS: process.argv.includes('--obs') }); console.log('.env 配置检查通过。'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
