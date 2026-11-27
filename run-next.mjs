import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

try {
  const env = loadEnv();
  const [mode, ...args] = process.argv.slice(2);
  if (!['dev', 'build', 'build:studio'].includes(mode)) throw new Error('未知 Next.js 启动模式');
  if (mode === 'build:studio') process.env.STUDIO_BUILD = '1';
  const child = spawn(process.execPath, [fileURLToPath(new URL('./node_modules/next/dist/bin/next', import.meta.url)),
    mode === 'dev' ? 'dev' : 'build', ...(mode === 'dev' ? ['--hostname', '127.0.0.1', '--port', env.PORT] : []), ...args],
  { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('无法启动 Next.js，请先安装项目依赖。'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
