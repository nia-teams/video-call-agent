#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_auto="$task_root/automation/obs-wecom"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --check ) ]]; then
  printf '%s\n' '支持的参数只有 --check（只读检查）。' >&2
  exit 1
fi
source "$task_root/scripts/node-runtime.sh"
source "$task_root/scripts/automation-runtime.sh"
task_prepare_automation "$task_root"
task_select_node "$task_root"
"$task_node" "$task_root/env.mjs" --obs
if [[ ! -d "$task_root/node_modules/next" || ! -d "$task_root/node_modules/obs-websocket-js" ]]; then
  printf '%s\n' '项目依赖未安装，请先在项目根目录执行 npm ci。'
  exit 1
fi
source "$task_root/scripts/install-checks.sh"
if ! task_probe_driver; then
  printf 'Node Audio Bridge：%s\n' "$(task_driver_hint)" >&2
  exit 1
fi
mkdir -p "$task_auto/.build"
if [[ ! -x "$task_auto/.build/CameraSwitch" || "$task_auto/CameraSwitch.swift" -nt "$task_auto/.build/CameraSwitch" ]]; then
  printf '%s\n' '编译 CameraSwitch……'
  /usr/bin/xcrun swiftc -O -module-cache-path "$task_auto/.build/module-cache" "$task_auto/CameraSwitch.swift" -o "$task_auto/.build/CameraSwitch"
fi
if ! task_auto_audio_is_current "$task_auto"; then
  printf '%s\n' '编译 AutoAudio……'
  task_build_auto_audio "$task_auto"
fi
if [[ ! -x "$task_root/media/native/.build/WeComCapture" || ! -x "$task_root/media/native/.build/AudioProbe" || "$task_root/media/native/AudioProbe.swift" -nt "$task_root/media/native/.build/AudioProbe" || "$task_root/media/native/WeComCapture.swift" -nt "$task_root/media/native/.build/WeComCapture" ]]; then
  /bin/zsh "$task_root/media/native/build.sh"
fi
if [[ "${1:-}" == '--check' ]]; then
  if ! task_probe_audio_devices "$task_root"; then
    printf '%s\n' '新版 Node Audio Send 或 Node Virtual Mic 未加载。请运行 npm run setup:check；需要更新 AudioProbe 时请重新运行 npm run setup。' >&2
    exit 1
  fi
  "$task_auto/.build/AutoAudio" --check
  "$task_auto/.build/CameraSwitch" --check
  "$task_node" "$task_root/media/obs-cli.mjs" status
  exit $?
fi
exec "$task_node" "$task_auto/media-launcher.mjs"
