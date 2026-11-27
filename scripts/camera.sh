#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_dir="$task_root/automation/obs-wecom"
source "$task_root/scripts/automation-runtime.sh"
task_prepare_automation "$task_root"
task_binary="$task_dir/.build/CameraSwitch"
mkdir -p "$task_dir/.build"
if [[ ! -x "$task_binary" || "$task_dir/CameraSwitch.swift" -nt "$task_binary" ]]; then
  /usr/bin/xcrun swiftc -O -module-cache-path "$task_dir/.build/module-cache" "$task_dir/CameraSwitch.swift" -o "$task_binary"
fi
if [[ "${1:-}" == --calibrate-camera ]]; then
  printf '%s\n' '8 秒内切回企微通话，显示控制栏，将鼠标停在摄像头图标中心。'
  sleep 8
fi
exec "$task_binary" "$@"
