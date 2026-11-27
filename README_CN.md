# Video Call Agent

[English](README.md)

**让 AI 在企业微信里自己接听 1v1 视频电话，和人面对面实时聊天。**

当别人给运行在 Mac 上的 AI 企业微信账号拨打 1v1 语音或视频电话时，AI 自动接听，实时看见对方画面、听懂对方说话、直接开口回应，并以内置 2D 数字人同步对口型出镜；挂断后自动结束采集与模型会话。

```text
拨入 AI 企微通话 ──(画面 + 声音)──▶ 本机采集 ──▶ 实时语音模型（Qwen / OpenAI）
对方看到和听到   ◀──(OBS 虚拟摄像头 + 虚拟麦克风)── AI 数字人 / 画面 + 回复语音
```

## 核心能力

- **AI 自主接听视频电话**：来电自动接起，AI 实时看见画面、听懂语音并直接开口对话，内置 2D 数字人随语音实时对口型出镜，挂断自动清理。
- **灵活切换出镜画面**：通话中可随时将画面在内置数字人、本地视频、真实摄像头、共享窗口以及 Live Canvas 互动白板之间切换。
- **全链路跑在本机**：直接配合官方企业微信 Mac 客户端运行，不修改客户端；密钥留在本地 `.env`，服务仅监听 `127.0.0.1`。

## 环境要求

- **macOS 14.2+**（建议使用本机支持的最新正式版）与 Xcode Command Line Tools
- **Node.js 24.x**（`.nvmrc`）
- **OBS Studio**（官方最新稳定版）、**Google Chrome**、**企业微信 Mac 客户端**

## 快速开始

### 1. 安装依赖与虚拟音频驱动

使用普通账号运行（仅在 Homebrew 或驱动提示时输入管理员密码；驱动安装会重启系统音频服务，请在未通话时执行）：

```bash
git clone https://github.com/nia-teams/video-call-agent.git
cd video-call-agent
bash ./install-dependencies.sh     # 已有 npm 时也可执行 npm run setup
npm run setup:check
```

可用 `npm run setup:plan` 预览安装步骤；如只需本机媒体控制台、暂不接通话音频，可加 `--skip-driver` 跳过驱动安装。

### 2. 配置 `.env`

```bash
cp .env.example .env
chmod 600 .env
```

填写 OBS WebSocket 密码和实时语音模型配置：

```dotenv
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=<你的OBS密码>
DASHSCOPE_API_KEY=<你的APIKey>
QWEN_REALTIME_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime
QWEN_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_VOICE=Raymond
```

- 支持阿里云 DashScope 或其他兼容[实时语音协议](media/QWEN.md)的可信 `wss://` 端点。不用 Qwen 时把 Key 和 URL 同时留空即可；Live Canvas 真实语音模式使用 `OPENAI_API_KEY`。
- OBS 未运行时，启动器会自动按 `.env` 开启并配置 OBS WebSocket；OBS 已运行时需确保端口与密码一致。

### 3. 完成首次授权并启动

1. 给启动终端授予 **辅助功能** 与 **屏幕录制**（或 **屏幕与系统音频录制**）权限，在 macOS 系统设置中批准 **OBS 相机扩展**，并允许企微和 Chrome 使用摄像头与麦克风。各系统版本的逐项操作路径见[新电脑首次授权清单](docs/NEW_MAC_SETUP.md)。
2. 企微通话选择 **OBS Virtual Camera** 和 **Node Virtual Mic**；Chrome 控制台输出选 **Node Audio Send**；企微扬声器和系统默认输出保持实体耳机或扬声器，避免回声。
3. 检查并启动：

```bash
npm run env:check
npm run start:check
npm start
```

打开控制台 `http://127.0.0.1:3070/`（OBS 浏览器源地址为 `http://127.0.0.1:3070/studio/output`），找知情测试方打一通 1v1 视频电话即可验收。新版企微的悬停式摄像头按钮在新电脑上首次使用需在通话中跑一次 `npm run camera:calibrate` 定位（见[摄像头兼容说明](automation/obs-wecom/CAMERA_COMPATIBILITY.md)）。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` / `npm stop` | 启动或停止完整通话流程（在 `.env` 将 `STUDIO_AUTO_ANSWER=0` 或 `STUDIO_AUTO_CAPTURE=0` 可切为手动控制） |
| `npm run studio` | 仅启动本机媒体控制台，不开启来电监控 |
| `npm run start:check` | 检查虚拟音频设备、辅助功能权限与 OBS 连接 |
| `npm run driver:build` / `npm run driver:install` | 单独构建与安装 [Node Audio Bridge](media/native/node-audio-driver/README.md) 虚拟声卡 |
| `npm run test:media` / `test:studio` / `test:qwen` / `test:live-canvas` | 运行自动化测试 |

## 目录结构

- `app/`、`lib/` — Next.js 媒体控制台、Qwen 与 Live Canvas 界面
- `media/` — 本机媒体服务、Qwen 适配、macOS 音视频采集组件、内置数字人与 [SpeechLipSync](media/avatar-assets/SPEECH_LIPSYNC.md)、可选 [Node Audio Bridge 虚拟驱动](media/native/node-audio-driver/README.md)
- `automation/obs-wecom/`、`scripts/`、`skills/obs-virtual-camera/` — 通话自动化调度、安装启动脚本与 Agent Skill

## 隐私、许可证与商标声明

采集、录音或将通话音视频转发给模型前，请先取得参与者同意。录音默认关闭；服务仅限本机 `127.0.0.1` 访问。

- **应用代码与内置数字人资源**：采用 [MIT 许可证](LICENSE)。
- **Node Audio Bridge（`media/native/node-audio-driver/`）**：基于 BlackHole 派生的独立 macOS HAL 虚拟音频驱动，仅以源码形式单独按 **GPL-3.0** 分发，不在主项目 MIT 许可范围内（应用通过系统音频设备通信，不链接驱动代码）。详见[第三方声明](THIRD_PARTY_NOTICES.md)。
- **商标声明**：腾讯/企业微信（WeCom）、OBS Studio、Existential Audio/BlackHole、阿里云/通义千问/DashScope、OpenAI 等名称及商标归各自权利人所有。本项目为独立开源项目，与上述各方无隶属或背书关系。
