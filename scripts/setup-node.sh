#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$task_root/scripts/install-checks.sh"
source "$task_root/scripts/node-runtime.sh"
task_brew="$(task_find_brew || true)"
task_select_node "$task_root" install
