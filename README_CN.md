# Video Call Agent

[English](README.md)

在 macOS 上将企业微信一对一通话接入实时语音模型。应用采集通话窗口及企微播放的声音，以模型回复音频驱动 HeR 数字人口型，再通过 OBS 虚拟摄像头和虚拟麦克风将画面与声音送回通话。也可以发送视频、摄像头、共享窗口或 Live Canvas 画板。

## 安装

- **macOS 14.2 或更高**，支持 Apple Silicon 和 Intel。通话采集使用 ScreenCaptureKit；`AudioProbe.swift` 使用 macOS 14.2 起提供的 CoreAudio 进程音频 API。建议使用本机支持的最新官方稳定版 macOS。
- [OBS Studio](https://obsproject.com/download) 官方最新稳定版，安装到 `/Applications`。
- **Node.js 24.x**（见 `.nvmrc`）及随该版本提供的 npm。

```bash
git clone https://github.com/nia-teams/video-call-agent.git
cd video-call-agent
bash ./install-dependencies.sh    # 已有 npm 时可用 npm run setup
npm run setup:check
```

安装器检查 Xcode Command Line Tools，准备 Homebrew 和 Node 24，补装 OBS、Chrome 和企业微信，执行 `npm ci`，编译原生组件并安装缺失的驱动。若系统提示安装命令行工具，完成后重跑安装器。使用普通账号运行；仅在提示时授予管理员权限。安装驱动会重启 CoreAudio，请先结束通话和录音。

| 命令 | 用途 |
| --- | --- |
| `npm run setup:plan` | 查看安装计划 |
| `npm run setup -- --skip-driver` | 暂不安装驱动；完整一键通话仍需要驱动 |
| `npm run node:setup` | 仅准备或切换到 Node 24 |

手动安装、更换和卸载见 [Node Audio Bridge](media/native/node-audio-driver/README.md)。

## 配置

在项目根目录创建配置文件；已有 `.env` 时直接编辑。修改后重启。

```bash
cp .env.example .env
chmod 600 .env
```

```dotenv
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=<你的 OBS 密码>
DASHSCOPE_API_KEY=<你的 API Key>
QWEN_REALTIME_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime
QWEN_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_VOICE=Raymond
```

- **OBS**：WebSocket 使用本机地址并启用密码认证。OBS 未运行时，启动器会备份原配置并按 `.env` 启用服务；OBS 已运行时，端口和密码须与配置一致。
- **Qwen**：可使用 DashScope 或获授权且协议兼容的 `wss://` 端点。模型可由 URL 的 `model` 或 `QWEN_REALTIME_MODEL` 指定，两处都填须一致，均未指定时使用 `qwen3.5-omni-flash-realtime`。校验规则见 [Qwen 配置](media/QWEN.md)。
- **可选服务**：不使用 Qwen 时，同时留空密钥和端点；本机媒体控制台与 Live Canvas 无密钥演示仍可用。Live Canvas 真实语音需要 `OPENAI_API_KEY`。勿提交 `.env`。

## Mac 首次运行

1. 登录 macOS 图形桌面及官方企业微信客户端，保持桌面解锁。后续从同一个已授权的终端应用启动；单独 SSH 登录无法操作通话界面。
2. 在「隐私与安全性」中，为实际启动项目的终端授权「辅助功能」和「屏幕录制」或「屏幕与系统音频录制」。若系统单独列出 `CameraSwitch` 或 `WeComCapture`，按请求授权。必要时退出并重新打开对应应用。
3. 在 OBS 启动虚拟摄像机并批准相机扩展。macOS 14 在「隐私与安全性 → 安全性」批准；macOS 15 及以后在「通用 → 登录项与扩展 → 相机扩展」启用。按提示重启 OBS；若企微仍未刷新设备列表，结束通话后再重启企微。
4. 在系统设置中允许企微使用麦克风和摄像头。
5. 在项目根目录运行 `npm run env:check`、`npm run start:check` 和 `npm start`。打开[控制台](http://127.0.0.1:3070/)并检查 [OBS 输出页](http://127.0.0.1:3070/studio/output)。在 Chrome 允许本站使用麦克风，刷新设备并按下表选路；如拦截自动播放，点击「连接 Qwen」启用音频。默认浏览器源为 1080×1920，OBS 只传视频。
6. 测试通话中确认企微使用 OBS 虚拟摄像头。旧版打开右上角下拉菜单；新版将鼠标移入视频区，等控制栏出现，再悬停摄像头按钮约 1 秒，不要点击。若启动器无法定位按钮，先运行 `npm run camera:calibrate`。
7. 请知情的测试方拨入一对一视频，验收自动接听、窗口和声音采集、模型连接、HeR 画面与口型，并由对端确认能听到回复、看到画面。挂断后核对采集和会话均已结束。

| 位置 | 设备 |
| --- | --- |
| 企微摄像头 | **OBS Virtual Camera** |
| 企微麦克风和 macOS 默认输入 | **Node Virtual Mic** |
| 控制台 Qwen 输出 | **Node Audio Send** |
| 企微扬声器和 macOS 默认输出 | 实体耳机或扬声器 |

详见[新 Mac 安装与权限清单](docs/NEW_MAC_SETUP.md)和[摄像头定位与版本兼容](automation/obs-wecom/CAMERA_COMPATIBILITY.md)。

## 日常使用

| 命令或配置 | 行为 |
| --- | --- |
| `npm start` | 默认自动接听、自动采集，采集就绪后连接选定模型（默认 Qwen） |
| `STUDIO_AUTO_ANSWER=0` | 手动接听，仍可在接通后自动采集 |
| `STUDIO_AUTO_CAPTURE=0` | 在控制台手动选择窗口、开始采集并连接模型 |
| `npm run studio` | 只启动媒体控制台，不启动通话监控 |
| `npm stop` | 停止启动器及它启动的组件，保留 OBS 和企微 |

通过控制台切换视频、摄像头、窗口和画板；选择「不连接 AI」可结束当前模型转接。录音默认关闭。媒体来源、录音和 API 见[媒体服务说明](media/README.md)。

## 项目结构与验证

- `app/`、`lib/`：Next.js 控制台和模型集成。
- `media/`：本机媒体服务、Qwen 服务端连接、原生音视频组件与 [HeR 口型引擎](media/avatar-assets/SPEECH_LIPSYNC.md)。
- `automation/obs-wecom/`、`scripts/`、`skills/obs-virtual-camera/`：通话自动化、安装启动脚本与虚拟摄像头操作说明。
- `.env`、`.runtime/`：本机配置、日志和可选录音，不提交 Git。

```bash
npm run typecheck
npm run test:studio
npm run test:qwen
npm run test:live-canvas
npm run test:media
npm run build:studio -- --webpack
node scripts/check-public-source.mjs
```

采集、录音或将媒体发给模型前，应征得通话参与者同意。企微模式会向所配置的 Qwen 服务发送应用音频和窗口画面。服务仅供本机访问，请勿经代理或端口转发公开。

## 许可证与商标

本项目应用代码采用 [MIT 许可证](LICENSE)，另有声明的文件除外。[Node Audio Bridge](media/native/node-audio-driver/README.md) 是单独构建和安装的 **GPL-3.0** 源码组件。应用通过 macOS 音频设备与其通信，不链接驱动代码。素材和依赖许可见[第三方声明](THIRD_PARTY_NOTICES.md)。

腾讯与企业微信（WeCom）、OBS Studio、Existential Audio 与 BlackHole、阿里云及 Qwen／DashScope、OpenAI 的名称或商标归各自权利人所有。本项目与上述权利人无隶属关系，也未获其赞助或背书。
