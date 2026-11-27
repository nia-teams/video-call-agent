#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$task_root/scripts/node-runtime.sh"
task_select_node "$task_root"
exec "$task_node" "$task_root/automation/obs-wecom/media-launcher.mjs" --stop
