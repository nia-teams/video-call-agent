# 本机媒体服务

按[项目配置说明](../README_CN.md#配置)准备项目后，运行 `npm run studio` 启动控制台，不开启企微通话监控。生产运行先执行 `npm run build:studio -- --webpack`，再执行 `npm run studio:production`。自定义 Node 服务提供媒体 API。

## 媒体来源

- **发送**：上传视频（最多 256 MiB）、HTTP(S) 视频直链、摄像头、共享窗口、[内置数字人](avatar-assets/SPEECH_LIPSYNC.md)或 Live Canvas。画板逐步更新会同步到 OBS；语音、控制按钮和历史选择器不进入发送画面。
- **接收**：手动刷新窗口列表，选择获授权的企微通话窗口，再开始或停止采集。音频来自企微应用播放，可能包含通知音，并非对方的原始音轨。
- **录音**：在控制台开启后可手动启停，或在自动采集模式下随通话启停。文件位于 `.runtime/media-studio/recordings/`，可在控制台预览、下载或删除。

默认端口为 `3070`，控制台为 <http://127.0.0.1:3070/>，OBS 浏览器源为 <http://127.0.0.1:3070/studio/output>。同一浏览器只允许一个控制台连接媒体流；关掉当前标签页后，等待页可接管。

## HTTP API

| 端点 | 用途 |
| --- | --- |
| `GET /bridge/state` | 服务状态和 `csrfToken` |
| `POST /bridge/windows` | 列出可采集的企微窗口 |
| `POST /bridge/capture/start`、`/bridge/capture/stop` | 启停采集 |
| `POST /bridge/source`、`/bridge/upload` | 切换来源、上传媒体文件 |
| `GET /bridge/snapshot/incoming` | 最新采集 JPEG；采集中断时返回 503 |
| `GET /bridge/video/{incoming,outgoing}` | JPEG 多段流 |
| `GET /bridge/audio/{incoming,outgoing}` | PCM 的 SSE 订阅 |

服务绑定到本机回环接口，拒绝非本机 Host 和跨站请求。普通写操作要求本机同源 `Origin` 及 `X-Studio-Token`，其值来自 `/bridge/state` 的 `csrfToken`。`/bridge/ingest/*` 使用独立原生采集令牌。运行 `npm run test:media` 验证媒体协议与访问控制。
