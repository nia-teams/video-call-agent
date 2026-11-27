import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { createBridge, localHost } from './bridge.mjs';
import { createQwen } from './qwen.mjs';
import { loadEnv } from '../env.mjs';
import { prepareOBS } from './obs.mjs';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let env;
try { env = loadEnv(); }
catch (error) { console.error(error.message); process.exit(1); }
const port = Number(env.PORT);
const dev = process.env.NODE_ENV !== 'production';
if (dev) process.env.STUDIO_DEV = '1';
else process.env.STUDIO_BUILD = '1';
const app = next({ dev, dir: webDir, hostname: '127.0.0.1', port, webpack: true, conf:{distDir:dev?'.next-studio-dev':'.next-studio',devIndicators:false} });
await app.prepare();
const nextHandle = app.getRequestHandler();
let qwen;
const bridge = createBridge({ onIncomingAudio: bytes => qwen?.incoming(bytes), directory: path.join(webDir, '.runtime/media-studio'), helper: path.join(webDir, 'media/native/.build/WeComCapture'), port, onAvatarStart: () => prepareOBS(), onOutputPrepare: () => prepareOBS({ configureSource: true, refreshSource: true }) });
qwen = createQwen({ bridge, env, onStatus: status => console.log(`Qwen session ${JSON.stringify(status)}`) });
const server = http.createServer(async (req, res) => {
  if (!localHost(req.headers.host)) { res.writeHead(403); res.end('Local access only'); return; }
  try { const url = new URL(req.url, `http://${req.headers.host}`); if (!(await bridge.handle(req, res, url))) await nextHandle(req, res); }
  catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
server.on('upgrade', (req, socket, head) => { if (qwen.upgrade(req, socket, head)) return; if (!localHost(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') socket.destroy(); else void app.getUpgradeHandler()(req, socket, head); });
server.listen(port, '127.0.0.1', () => console.log(`媒体控制台：http://127.0.0.1:${port}\nOBS 浏览器源：http://127.0.0.1:${port}/studio/output`));
server.on('error', error => { console.error(`无法监听端口 ${port}：${error.message}。请修改 .env 中的 PORT。`); bridge.close(); process.exit(1); });
let closing = false;
async function stop() { if (closing) return; closing = true; qwen.close(); bridge.close(); server.close(); server.closeAllConnections(); await app.close(); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
