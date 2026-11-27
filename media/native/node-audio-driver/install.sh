#!/bin/bash
set -eu
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
task_source="$task_dir/../.build/NodeAudioBridge.driver"
task_destination="/Library/Audio/Plug-Ins/HAL/NodeAudioBridge.driver"
if [[ -e "$task_destination" || -L "$task_destination" ]]; then
  echo '已存在 NodeAudioBridge.driver，停止以免覆盖。若为旧版或不匹配，请先结束通话和录音，按驱动 README 将它移出 HAL 目录并保留备份，再重试。' >&2
  exit 1
fi
[[ -d "$task_source" ]] || { echo '驱动尚未构建，请先运行 npm run driver:build。' >&2; exit 1; }
task_expected_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$task_dir/Info.plist")"
task_source_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$task_source/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$task_expected_id" && "$task_source_id" == "$task_expected_id" ]] || {
  echo "构建产物的 Bundle ID 缺失或不匹配（需要 $task_expected_id），请重新运行 npm run driver:build。" >&2
  exit 1
}
if (( EUID != 0 )); then
  echo '安装 Node Audio Send / Node Virtual Mic，需要 macOS 管理员授权。'
  echo '现有 BlackHole 将保留；安装后会重启音频服务，当前通话声音会短暂中断。'
  exec /usr/bin/sudo /bin/bash "$0"
fi
/usr/bin/codesign --verify --strict "$task_source"
/usr/bin/ditto "$task_source" "$task_destination"
/usr/sbin/chown -R root:wheel "$task_destination"
/bin/chmod -R go-w "$task_destination"
/usr/bin/killall coreaudiod || true
echo '安装完成。设备应显示 Node Audio Send（输出）和 Node Virtual Mic（输入）。'
