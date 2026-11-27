import { readFile, mkdir, writeFile, copyFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function initializeOBSWebSocket({
  configFile = path.join(homedir(), 'Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json'),
  isRunning = async () => {
    try { await execute('/usr/bin/pgrep', ['-x', 'OBS']); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  },
  port,
  password,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof password !== 'string' || !password.trim() || /[\r\n]/.test(password)) throw new Error('请在 .env 配置有效的 OBS WebSocket 端口和密码');
  let config = {}, exists = false;
  try { config = JSON.parse(await readFile(configFile, 'utf8')); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('OBS WebSocket 配置无法读取，请检查原配置；未覆盖'); }
  if (config.server_enabled && config.auth_required && config.server_password === password && config.server_port === port) return false;
  if (await isRunning()) throw new Error('OBS 已运行但 WebSocket 设置与 .env 不一致；请在 OBS「工具 → WebSocket 服务器设置」核对端口和密码，或退出 OBS 后重新启动项目以自动初始化');
  await mkdir(path.dirname(configFile), { recursive: true });
  if (exists) await copyFile(configFile, `${configFile}.before-wecom-${Date.now()}`);
  const next = { ...config, server_enabled: true, auth_required: true, server_port: port, server_password: password };
  const temporary = `${configFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, configFile);
  return true;
}
