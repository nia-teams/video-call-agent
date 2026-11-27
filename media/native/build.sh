#!/bin/zsh
set -eu
task_dir="${0:A:h}"
mkdir -p "$task_dir/.build"
xcrun swiftc -parse-as-library -O -module-cache-path "$task_dir/.build/module-cache" -framework ScreenCaptureKit "$task_dir/WeComCapture.swift" -o "$task_dir/.build/WeComCapture"
xcrun swiftc -O -module-cache-path "$task_dir/.build/module-cache" "$task_dir/AudioProbe.swift" -o "$task_dir/.build/AudioProbe"
