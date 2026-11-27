#!/bin/bash
# Read-only probes shared by the installer and its --check mode.
task_find_brew() {
  local task_candidate
  task_candidate="$(command -v brew || true)"
  if [[ -n "$task_candidate" ]]; then printf '%s\n' "$task_candidate"; return 0; fi
  for task_candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$task_candidate" ]]; then printf '%s\n' "$task_candidate"; return 0; fi
  done
  return 1
}

task_probe_toolchain() {
  /usr/bin/xcrun --find swiftc >/dev/null 2>&1 && /usr/bin/xcrun --find clang >/dev/null 2>&1
}
task_probe_app() {
  local task_app="$1" task_executable
  task_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$task_app/Contents/Info.plist" 2>/dev/null)" || return 1
  [[ -n "$task_executable" && -x "$task_app/Contents/MacOS/$task_executable" ]]
}
task_probe_binary() {
  [[ -x "$1" ]] && /usr/bin/file -b "$1" | /usr/bin/grep -q 'Mach-O.*executable'
}
task_driver_path='/Library/Audio/Plug-Ins/HAL/NodeAudioBridge.driver'
task_driver_bundle_id='com.nia-teams.NodeAudioBridge'
task_probe_driver() {
  local task_driver="${1:-$task_driver_path}" task_installed_id
  [[ -x "$task_driver/Contents/MacOS/NodeAudioBridge" ]] || return 1
  task_installed_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$task_driver/Contents/Info.plist" 2>/dev/null)" || return 1
  [[ "$task_installed_id" == "$task_driver_bundle_id" ]] && /usr/bin/codesign --verify --strict "$task_driver" >/dev/null 2>&1
}
task_driver_hint() {
  if [[ -e "$task_driver_path" || -L "$task_driver_path" ]]; then
    printf '已有旧版或无效驱动（需匹配 Bundle ID %s、文件完整且签名有效），不会覆盖。结束通话和录音后，请按 media/native/node-audio-driver/README.md 将 %s 移出 HAL 目录并保留备份，再运行 npm run setup。' "$task_driver_bundle_id" "$task_driver_path"
  else
    printf '未安装驱动，请运行 npm run setup。'
  fi
}
task_probe_auto_audio() {
  task_probe_binary "$1/.build/AutoAudio" && task_auto_audio_is_current "$1"
}
task_probe_audio_devices() {
  local task_probe="$1/media/native/.build/AudioProbe" task_audio_status
  [[ -x "$task_probe" ]] || return 1
  task_audio_status="$("$task_probe" 2>/dev/null)" || return 1
  printf '%s' "$task_audio_status" | node -e '
    let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
      try {const status=JSON.parse(input);process.exit(status.nodeMicInstalled===true && status.nodeSendInstalled===true ? 0 : 1);}
      catch {process.exit(1);}
    });' >/dev/null 2>&1
}

task_report_item() {
  local task_label="$1" task_hint="$2" task_optional="$3"
  shift 3
  task_total=$((task_total + 1))
  if "$@" >/dev/null 2>&1; then
    task_passed=$((task_passed + 1))
    printf '✅ %s\n' "$task_label"
  else
    if [[ -t 1 && "${TERM:-dumb}" != dumb ]]; then printf '\033[31m'; fi
    printf '❌ %s：%s' "$task_label" "$task_hint"
    if [[ "$task_optional" == 1 ]]; then
      printf '（已指定 --skip-driver，不计入必装项）'
    else
      task_failed=$((task_failed + 1))
    fi
    if [[ -t 1 && "${TERM:-dumb}" != dumb ]]; then printf '\033[0m'; fi
    printf '\n'
  fi
}

task_check_installation() {
  local task_project="$1" task_optional_driver="${2:-0}"
  local task_total=0 task_passed=0 task_failed=0 task_brew_path task_node_prefix task_name
  # Use the installer's Homebrew Node even in a fresh shell without its PATH setup.
  local PATH="$PATH"
  task_brew_path="$(task_find_brew)" || task_brew_path=''
  source "$task_project/scripts/node-runtime.sh"
  task_select_node "$task_project" >/dev/null 2>&1 || true
  printf '\n%s\n' '安装结果检查（只读）'
  task_report_item 'Xcode Command Line Tools' '缺少 Swift 或 Clang，请运行 xcode-select --install' 0 task_probe_toolchain
  task_report_item 'Homebrew' '未找到可用的 brew' 0 "${task_brew_path:-brew}" --version
  task_report_item 'Node.js 24' '未找到可用的项目版本；请在项目根目录运行 npm run setup 安装或用 nvm use 24 切换' 0 node -e 'process.exit(Number(process.versions.node.split(".")[0])===24?0:1)'
  task_report_item 'npm' '未找到可用的 npm' 0 npm --version
  task_report_item 'OBS Studio' '应用缺失或安装不完整；官方下载：https://obsproject.com/download' 0 task_probe_app '/Applications/OBS.app'
  task_report_item 'Google Chrome' '应用缺失或安装不完整；官方下载：https://www.google.com/chrome/' 0 task_probe_app '/Applications/Google Chrome.app'
  task_report_item '企业微信' '应用缺失或安装不完整；官方下载：https://work.weixin.qq.com/；Mac App Store：https://apps.apple.com/cn/app/企业微信/id1189898970?mt=12' 0 task_probe_app '/Applications/企业微信.app'
  task_report_item '项目 npm 依赖' '依赖缺失或版本不匹配，请执行 npm ci' 0 npm --prefix "$task_project" ls --depth=0 --include=dev
  for task_name in WeComCapture AudioProbe; do
    task_report_item "$task_name 原生组件" '缺失或不是可执行的原生程序，请重新运行安装脚本' 0 task_probe_binary "$task_project/media/native/.build/$task_name"
  done
  source "$task_project/scripts/automation-runtime.sh"
  task_report_item 'CameraSwitch 原生组件' '缺失或不是可执行的原生程序，请重新运行安装脚本' 0 task_probe_binary "$task_project/automation/obs-wecom/.build/CameraSwitch"
  task_report_item 'AutoAudio 原生组件' '缺失、不是可执行的原生程序或与源码不匹配，请运行 npm run setup 重新编译' 0 task_probe_auto_audio "$task_project/automation/obs-wecom"
  task_report_item 'Node Audio Bridge 驱动' "$(task_driver_hint)" "$task_optional_driver" task_probe_driver
  task_report_item 'Node Audio Send / Node Virtual Mic 设备' '新版输入或输出设备未加载，或 AudioProbe 未更新；请检查驱动并重新运行 npm run setup' "$task_optional_driver" task_probe_audio_devices "$task_project"
  printf '\n共检查 %s 项，通过 %s 项，必装项失败 %s 项。\n' "$task_total" "$task_passed" "$task_failed"
  [[ "$task_failed" == 0 ]]
}
