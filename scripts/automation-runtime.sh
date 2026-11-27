#!/bin/bash
# Preserve local configuration and camera calibration when updating an existing checkout.
task_prepare_automation() {
  local task_project="$1" task_old task_new task_file
  task_old="$task_project/web/automation/obs-wecom/.build"
  task_new="$task_project/automation/obs-wecom/.build"
  if [[ ! -e "$task_project/.env" && -f "$task_project/web/.env" ]]; then
    cp -p "$task_project/web/.env" "$task_project/.env"
  fi
  mkdir -p "$task_new"
  for task_file in camera-button.json camera-button.png; do
    if [[ -f "$task_old/$task_file" && ! -e "$task_new/$task_file" ]]; then
      cp -p "$task_old/$task_file" "$task_new/$task_file"
    fi
  done
  # Keep the old files available to a launcher that is still running during update.
}

# AutoAudio caches are tied to source bytes, not timestamps: a legacy binary
# copied during an earlier upgrade may be newer than the current Swift file.
task_auto_audio_hash() {
  /usr/bin/shasum -a 256 < "$1/AutoAudio.swift"
}
task_auto_audio_is_current() {
  local task_dir="$1" task_hash
  [[ -x "$task_dir/.build/AutoAudio" && -r "$task_dir/.build/AutoAudio.source-hash" ]] || return 1
  task_hash="$(task_auto_audio_hash "$task_dir")" || return 1
  [[ "$(cat "$task_dir/.build/AutoAudio.source-hash")" == "$task_hash" ]]
}
task_build_auto_audio() {
  local task_dir="$1" task_hash
  task_hash="$(task_auto_audio_hash "$task_dir")" || return 1
  /usr/bin/xcrun swiftc -O -module-cache-path "$task_dir/.build/module-cache" \
    "$task_dir/AutoAudio.swift" -o "$task_dir/.build/AutoAudio" || return 1
  printf '%s\n' "$task_hash" > "$task_dir/.build/AutoAudio.source-hash"
}
