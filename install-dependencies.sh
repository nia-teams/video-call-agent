#!/bin/bash
# Also support invoking this file with sh (including shells other than Bash).
if [ -z "${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi
set -eEuo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
task_dry_run=0
task_skip_driver=0
task_check_only=0
for task_arg in "$@"; do
  case "$task_arg" in
    --dry-run) task_dry_run=1 ;;
    --skip-driver) task_skip_driver=1 ;;
    --check) task_check_only=1 ;;
    --help|-h)
      printf '%s\n' '用法（项目根目录）：npm run setup -- [--dry-run | --check] [--skip-driver]'
      printf '%s\n' '--dry-run：只显示安装计划；--check：只检查安装结果；--skip-driver：跳过驱动安装，驱动检查失败不计入必装项。'
      exit 0 ;;
    *) printf '%s\n' >&2 "未知参数：$task_arg"; exit 1 ;;
  esac
done
(( ! task_dry_run || ! task_check_only )) || { printf '%s\n' >&2 '--dry-run 与 --check 不能同时使用。'; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { printf '%s\n' >&2 '仅支持 macOS。'; exit 1; }
(( EUID != 0 )) || { printf '%s\n' >&2 '请使用普通账号运行，不要对整个脚本使用 sudo。'; exit 1; }
if (( task_dry_run )); then
  printf '%s\n' '安装计划（不会下载、安装、编译或修改系统）：'
  printf '%s\n' '1. 检查 Xcode Command Line Tools；缺失时打开系统安装弹窗，完成后重新运行。'
  printf '%s\n' '2. 检查现有 Node；版本不符时用 nvm 选择 24，无 Node 时用 Homebrew 安装；安装缺失的 OBS、Chrome、企微。'
  printf '%s\n' '3. 在项目根目录执行 npm ci，编译 WeComCapture、AudioProbe、CameraSwitch、AutoAudio。'
  if (( ! task_skip_driver )); then
    printf '%s\n' '4. 构建并安装缺失的 Node Audio Bridge（管理员授权；重启音频服务）。'
  fi
  printf '%s\n' '最后按 README 完成系统权限、OBS WebSocket、企微登录和千问配置。'
  printf '%s\n' '安装结束或中途失败时，逐项显示 ✅ / ❌ 检查结果。'
  exit 0
fi
source "$task_root/scripts/install-checks.sh"
task_installer=''
task_install_exit() {
  local task_exit_status=$? task_checks_status=0
  trap - EXIT ERR
  if [[ -n "$task_installer" ]]; then /bin/rm -f "$task_installer"; fi
  task_check_installation "$task_root" "$task_skip_driver" || task_checks_status=$?
  if [[ -n "${task_log_dir:-}" ]]; then printf '分项安装日志：%s\n' "$task_log_dir"; fi
  if (( task_exit_status != 0 || task_checks_status != 0 )); then
    printf '%s\n' >&2 '❌ 安装检查未全部完成，请根据上方错误和官方下载地址处理后重新运行。'
    if (( task_exit_status != 0 )); then exit "$task_exit_status"; else exit "$task_checks_status"; fi
  fi
  printf '%s\n' '✅ 必装依赖检查通过。'
  if (( task_skip_driver )); then printf '%s\n' '本次跳过驱动安装；完整自动通话流程仍需要 Node Audio Bridge 及两个已加载的设备。'; fi
  if (( ! task_check_only )); then
    printf '%s\n' '下一步见 README_CN.md 第 3—7 节：授权 macOS 权限 → 开启 OBS WebSocket → 登录企微 → 配置千问密钥。'
    printf '%s\n' "启动：npm --prefix \"$task_root\" start"
    if [[ -n "${task_node_bin:-}" ]]; then printf '%s\n' "本终端使用 npm 前可执行：export PATH=\"$task_node_bin:\$PATH\""; fi
  fi
  printf '%s\n' '以上仅检查依赖安装；系统权限、OBS 配置、企微登录及千问连接需另行确认。'
  exit 0
}
trap task_install_exit EXIT
if (( task_check_only )); then exit 0; fi
if ! /usr/bin/xcrun --find swiftc >/dev/null 2>&1 || ! /usr/bin/xcrun --find clang >/dev/null 2>&1; then
  /usr/bin/xcode-select --install || true
  printf '%s\n' '请先在系统弹窗中完成 Xcode Command Line Tools 安装，再重新运行本脚本。'
  exit 1
fi

task_log_dir="$task_root/.runtime/install-dependencies/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$task_log_dir"
source "$task_root/scripts/install-actions.sh"
task_brew="$(task_find_brew || true)"
if [[ -z "$task_brew" ]]; then
  printf '%s\n' '从 Homebrew 官方仓库下载并运行安装程序，请按终端提示完成授权。'
  task_installer="$(/usr/bin/mktemp -t video-call-agent-brew-install)"
  if task_retry 'homebrew-download' /usr/bin/curl --fail --location --connect-timeout 30 --max-time 300 --proto '=https' --tlsv1.2 \
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$task_installer"; then
    task_step 'homebrew-install' /bin/bash "$task_installer" || true
  fi
  task_brew="$(task_find_brew || true)"
fi
source "$task_root/scripts/node-runtime.sh"
task_node_ready=0
if task_select_node "$task_root" install; then
  task_node_ready=1
else
  printf '%s\n' 'Node 安装/版本选择未完成；继续检查其他组件，具体原因见上方输出。' >&2
fi

task_install_app obs OBS.app 'https://obsproject.com/download'
task_install_app google-chrome 'Google Chrome.app' 'https://www.google.com/chrome/'
task_install_app wechatwork 企业微信.app 'https://work.weixin.qq.com/'

if [[ "$task_node_ready" == 1 ]] && node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)' >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  printf '%s\n' '安装锁定版本的 npm 依赖……'
  task_install_npm "$task_root" || true
else
  printf '%s\n' '缺少 Node.js 24 或 npm，跳过 npm ci。官方下载：https://nodejs.org/en/download'
fi
# Native components do not depend on OBS, WeCom or npm, so always attempt them.
task_step 'capture-build' /bin/zsh "$task_root/media/native/build.sh" || true
task_auto="$task_root/automation/obs-wecom"
mkdir -p "$task_auto/.build"
source "$task_root/scripts/automation-runtime.sh"
task_step 'CameraSwitch-build' /usr/bin/xcrun swiftc -O \
  -module-cache-path "$task_auto/.build/module-cache" \
  "$task_auto/CameraSwitch.swift" -o "$task_auto/.build/CameraSwitch" || true
task_step 'AutoAudio-build' task_build_auto_audio "$task_auto" || true
if (( ! task_skip_driver )); then
  if task_probe_driver; then
    printf '%s\n' 'Node Audio Bridge 已安装，Bundle ID 和签名校验通过，跳过安装。'
  elif [[ -e "$task_driver_path" || -L "$task_driver_path" ]]; then
    printf '%s\n' "$(task_driver_hint)" >&2
  elif task_step 'driver-build' /bin/zsh "$task_root/media/native/node-audio-driver/build.sh"; then
    printf '%s\n' '即将安装虚拟麦克风并重启系统音频服务。请确保当前没有通话或录音。'
    task_step 'driver-install' /bin/bash "$task_root/media/native/node-audio-driver/install.sh" || true
  fi
fi
