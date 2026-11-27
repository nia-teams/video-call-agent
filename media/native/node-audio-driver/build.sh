#!/bin/zsh
set -eu
task_dir="${0:A:h}"
task_output="$task_dir/../.build/NodeAudioBridge.driver"
mkdir -p "$task_output/Contents/MacOS" "$task_output/Contents/Resources"
xcrun clang -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -O2 -fblocks -Wno-format-extra-args -bundle \
  -framework CoreAudio -framework CoreFoundation -framework Accelerate \
  -include "$task_dir/DriverConfig.h" "$task_dir/vendor/BlackHole.c" \
  -o "$task_output/Contents/MacOS/NodeAudioBridge"
cp "$task_dir/Info.plist" "$task_output/Contents/Info.plist"
cp "$task_dir/vendor/LICENSE" "$task_output/Contents/Resources/LICENSE"
codesign --force --sign - "$task_output"
codesign --verify --strict "$task_output"
plutil -lint "$task_output/Contents/Info.plist"
echo "Built: $task_output"
