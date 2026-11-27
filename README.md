# Video Call Agent

[简体中文](README_CN.md)

**Give an AI its own WeCom video call presence on macOS.**

When someone places a one-to-one voice or video call to the AI's WeCom (企业微信) account, Video Call Agent answers automatically, streams the call's video and audio to a realtime multimodal model (such as Qwen Omni), and lets the AI respond with voice and a lip-synced 2D avatar over OBS Virtual Camera. When the call ends, capture and the model session close cleanly.

```text
Incoming WeCom call ──(video + audio)──▶ Local capture ──▶ Realtime voice model (Qwen / OpenAI)
Caller sees & hears ◀──(OBS Virtual Camera + Virtual Mic)── AI avatar / scene + reply audio
```

## What it does

- **Autonomous AI video calls:** The AI answers one-to-one WeCom calls on its own, sees and hears the caller in real time, speaks back directly, and animates the built-in 2D avatar in sync with its voice.
- **Flexible visual output:** Switch the AI's video feed anytime between the built-in avatar, a local video file, a physical camera, a shared window, or a Live Canvas interactive board.
- **Runs entirely on your Mac:** Works alongside the official WeCom macOS client without modifying it. Keys stay in a local `.env` file and the service listens on `127.0.0.1` only.

## Requirements

- **macOS 14.2+** (latest official stable release supported by your Mac recommended) and Xcode Command Line Tools
- **Node.js 24.x** (`.nvmrc`)
- **OBS Studio** (latest official stable release), **Google Chrome**, and the official **WeCom macOS client**

## Quick start

### 1. Install dependencies and the virtual audio driver

Run as a regular user (enter your admin password only when Homebrew or the audio driver prompts; finish active calls first because driver install restarts CoreAudio):

```bash
git clone https://github.com/nia-teams/video-call-agent.git
cd video-call-agent
bash ./install-dependencies.sh     # or: npm run setup
npm run setup:check
```

Use `npm run setup:plan` to preview the plan, or `npm run setup -- --skip-driver` to run only the media console without call audio routing.

### 2. Configure `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Fill in your OBS WebSocket password and realtime model credentials:

```dotenv
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=<your-obs-password>
DASHSCOPE_API_KEY=<your-api-key>
QWEN_REALTIME_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime
QWEN_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_VOICE=Raymond
```

- Any trusted `wss://` endpoint compatible with the [Qwen Realtime protocol](media/QWEN.md) works. Leave both Qwen fields blank to use the local media console without Qwen; Live Canvas live voice mode uses `OPENAI_API_KEY`.
- If OBS is not running, the launcher configures OBS WebSocket from `.env` automatically. If OBS is already running, enable WebSocket with matching port and password.

### 3. Grant macOS permissions and run

1. Grant your terminal **Accessibility** and **Screen Recording** (or **Screen & System Audio Recording**), approve the **OBS Camera Extension** in macOS System Settings, and allow microphone/camera access for WeCom and Chrome. See the [step-by-step new-Mac checklist (CN)](docs/NEW_MAC_SETUP.md) for exact menu paths by macOS version.
2. In WeCom, select **OBS Virtual Camera** and **Node Virtual Mic**; in the Chrome console, select **Node Audio Send**; keep WeCom and macOS playback on physical headphones or speakers to avoid feedback.
3. Verify and start:

```bash
npm run env:check
npm run start:check
npm start
```

Open the console at `http://127.0.0.1:3070/` (OBS browser source uses `http://127.0.0.1:3070/studio/output`) and place a test call with a consenting tester. If WeCom's newer hover-style camera button needs one-time calibration on a new Mac, run `npm run camera:calibrate` during a test call (see [camera compatibility notes](automation/obs-wecom/CAMERA_COMPATIBILITY.md)).

## Common commands

| Command | Purpose |
| --- | --- |
| `npm start` / `npm stop` | Start or stop the full call workflow (set `STUDIO_AUTO_ANSWER=0` or `STUDIO_AUTO_CAPTURE=0` in `.env` for manual control) |
| `npm run studio` | Run only the local media console without call monitoring |
| `npm run start:check` | Check audio devices, Accessibility permission, and OBS connection |
| `npm run driver:build` / `npm run driver:install` | Build and install [Node Audio Bridge](media/native/node-audio-driver/README.md) separately |
| `npm run test:media` / `test:studio` / `test:qwen` / `test:live-canvas` | Run automated test suites |

## Project layout

- `app/`, `lib/` — Next.js media console, Qwen and Live Canvas panels
- `media/` — Local media server, Qwen adapter, macOS capture/audio helpers, built-in 2D avatar with [SpeechLipSync](media/avatar-assets/SPEECH_LIPSYNC.md), and the optional [Node Audio Bridge driver](media/native/node-audio-driver/README.md)
- `automation/obs-wecom/`, `scripts/`, `skills/obs-virtual-camera/` — Call lifecycle automation, setup/launch scripts, and agent skill

## Privacy, license, and trademarks

Get participants' consent before enabling call capture, recording, or model forwarding. Recording is off by default; keep the service on loopback (`127.0.0.1`).

- **Application & built-in avatar:** [MIT License](LICENSE).
- **Node Audio Bridge (`media/native/node-audio-driver/`):** Optional standalone macOS HAL audio driver derived from BlackHole, distributed as source only under **GPL-3.0** (separate from the MIT application; the app uses its macOS audio devices without linking to it). See [Third-party notices](THIRD_PARTY_NOTICES.md).
- **Trademarks:** Tencent/WeCom, OBS Studio, Existential Audio/BlackHole, Alibaba Cloud/Qwen/DashScope, and OpenAI belong to their respective owners. Video Call Agent is an independent project and is not affiliated with or endorsed by them.
