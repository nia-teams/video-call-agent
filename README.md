# Video Call Agent

[简体中文](README_CN.md)

Video Call Agent connects one-to-one WeCom calls on macOS to a realtime voice model. It captures the call window and app audio, animates the built-in HeR avatar from reply PCM, and sends video and audio back through OBS Virtual Camera and a virtual microphone. The console also supports video files, camera and window sharing, and a Live Canvas demo.

## Install

- **macOS 14.2 or later** on Apple Silicon or Intel. Call capture uses ScreenCaptureKit; `AudioProbe.swift` uses CoreAudio process audio APIs available since 14.2. Use the latest official stable macOS your Mac supports.
- The latest official stable [OBS Studio](https://obsproject.com/download), installed in `/Applications`.
- **Node.js 24.x** (`.nvmrc`) and its bundled npm.

```bash
git clone https://github.com/nia-teams/video-call-agent.git
cd video-call-agent
bash ./install-dependencies.sh     # Use npm run setup if npm is already available
npm run setup:check
```

Setup checks Xcode Command Line Tools, prepares Homebrew and Node 24 if needed, installs missing OBS, Chrome, and WeCom apps, runs `npm ci`, builds the native helpers, and installs the Node Audio Bridge driver if it is missing. If macOS prompts to install Command Line Tools, complete the installation and rerun setup. Setup leaves existing apps and drivers in place and reports a mismatched driver bundle ID or invalid signature. Run as a regular user; grant administrator approval only when prompted. Driver installation restarts CoreAudio, so finish calls and recordings first. To preview setup, use `npm run setup:plan`; to defer driver installation, use `npm run setup -- --skip-driver`. The full one-click call flow needs the driver.

For manual driver installation, replacement, or removal, see the [Node Audio Bridge guide](media/native/node-audio-driver/README.md).

## Configure

Create `.env` once from the template (`cp .env.example .env && chmod 600 .env`). Edit it in place if it already exists. Restart after changes. Enable OBS WebSocket with password authentication and enter its loopback URL and password. If OBS is not running, the launcher can configure it from these values and back up the previous settings. If OBS is already running, its settings must match.

```dotenv
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=<your-obs-password>
DASHSCOPE_API_KEY=<your-api-key>
QWEN_REALTIME_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime
QWEN_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_VOICE=Raymond
```

Use DashScope or another trusted, authorized `wss://` endpoint that supports the app's realtime voice protocol. URLs must not contain credentials or fragments. Leave `QWEN_REALTIME_MODEL` blank to use the URL's `model`; if neither specifies it, the app appends `qwen3.5-omni-flash-realtime`. When both specify a model, they must match, and duplicate `model` query parameters are rejected. The server must acknowledge the selected model and voice before the app sends audio. See [Qwen configuration](media/QWEN.md). Leave both the key and URL blank to skip Qwen; the local media console and Live Canvas demo still work. Live Canvas's live voice mode needs `OPENAI_API_KEY`. API keys stay on the server; never commit `.env`.

## First run on a Mac

1. Log in to the Mac's graphical session and the official WeCom client. Keep the desktop unlocked for the test and launch from the same terminal app after granting permissions. SSH alone cannot provide the GUI session.
2. Grant the launching terminal (and the native helper, if listed) **Accessibility** for call controls and **Screen Recording** or **Screen & System Audio Recording** for capture. Restart the affected apps after granting access if prompted.
3. Start OBS Virtual Camera once and approve the camera extension. On macOS 14, look under **Privacy & Security → Security**; on macOS 15 or later, use **General → Login Items & Extensions → Camera Extensions**. Restart OBS, and reopen WeCom after ending any active call if the device list is stale. See [OBS troubleshooting](https://obsproject.com/kb/virtual-camera-troubleshooting).
4. Grant WeCom access to the camera and microphone in macOS Settings.
5. Run `npm run env:check`, then `npm run start:check` and `npm start`. Open the [console](http://127.0.0.1:3070/) and check the [OBS output page](http://127.0.0.1:3070/studio/output). In Chrome, grant the console microphone access and refresh its device list. Use **Node Audio Send** for console output, **Node Virtual Mic** for WeCom and the macOS default input, and physical headphones or speakers for WeCom and the macOS default output. If Chrome blocks autoplay, click **Connect Qwen** once. The browser source uses 1080×1920 at the default port; OBS sends video only. The launcher preserves other OBS sources and does not start streaming or recording.
6. In a test call, select **OBS Virtual Camera** in WeCom's one-to-one call controls. Older clients expose a dropdown in the upper right; on newer clients, move the pointer over the video area, then hover over the camera button for about one second without clicking. Run `npm run camera:calibrate` once on a new setup if the launcher needs help locating that button.
7. Have a consenting tester place a one-to-one video call. Confirm auto-answer, capture, model connection and the avatar preview; ask the tester to confirm that the reply is audible and the video is visible. Hang up and check that capture and the model session close. Setup and permission checks do not replace this call test.

See the [new-Mac checklist](docs/NEW_MAC_SETUP.md) and [camera calibration guide](automation/obs-wecom/CAMERA_COMPATIBILITY.md) for detailed instructions in Chinese.

## Daily use

`npm start` enables auto-answer and auto-capture by default. Set `STUDIO_AUTO_ANSWER=0` for manual answering; set `STUDIO_AUTO_CAPTURE=0` for manual capture and model connection. `npm run studio` starts the console without the call monitor. `npm stop` stops the launcher and its components, leaving OBS and WeCom open. See the [media service guide](media/README.md) for endpoints, sources, and recording.

## Architecture and verification

- `app/`, `lib/`: Next.js console and provider integrations.
- `media/`: loopback media service, Qwen server connection, native CoreAudio/capture helpers, and HeR avatar with independent PCM-driven lip sync.
- `automation/obs-wecom/`, `scripts/`, `skills/obs-virtual-camera/`: macOS call lifecycle, launch and setup scripts, and OBS camera guidance.
- `.env` and `.runtime/`: local configuration, logs and optional recordings; excluded from Git.

```bash
npm run typecheck
npm run test:studio
npm run test:qwen
npm run test:live-canvas
npm run test:media
npm run build:studio -- --webpack
node scripts/check-public-source.mjs
```

Keep the service on loopback; do not expose it via proxies or port forwarding. Obtain participants' consent before capturing, recording, or sending their media to a model provider. In WeCom mode, Qwen receives app audio and window images. Recording is off by default.

## License and trademarks

Project-owned application code is [MIT](LICENSE), except where noted. [Node Audio Bridge](media/native/node-audio-driver/README.md) is a standalone **GPL-3.0** component distributed as source only and built and installed separately. The MIT app uses its macOS audio devices without linking to the driver. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency, driver, and avatar terms.

Tencent and WeCom, OBS Studio, Existential Audio and BlackHole, Alibaba Cloud and Qwen/DashScope, and OpenAI are names or trademarks of their respective owners. They identify compatibility, services, or source provenance. Video Call Agent is not affiliated with, sponsored by, or endorsed by those owners.
