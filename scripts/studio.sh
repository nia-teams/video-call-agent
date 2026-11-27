#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$task_root/scripts/node-runtime.sh"
source "$task_root/scripts/automation-runtime.sh"
task_prepare_automation "$task_root"
task_select_node "$task_root"
cd "$task_root"
"$task_node" env.mjs
if [[ ! -d node_modules/next ]]; then npm ci; fi
if [[ ! -x media/native/.build/WeComCapture || ! -x media/native/.build/AudioProbe || media/native/WeComCapture.swift -nt media/native/.build/WeComCapture || media/native/AudioProbe.swift -nt media/native/.build/AudioProbe ]]; then
  printf '%s\n' '编译 macOS 窗口与应用音频采集组件……'
  zsh media/native/build.sh
fi
printf '%s\n' '按 Control+C 停止服务和采集；访问地址以服务启动输出为准。'
exec "$task_node" media/server.mjs
