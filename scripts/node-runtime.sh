#!/bin/bash
# Shared by Bash and Zsh entry points. Call directly, never in $(...), so PATH persists.
task_find_node() {
  local candidate
  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  done
  candidate="$(find "${NVM_DIR:-$HOME/.nvm}/versions/node" -mindepth 3 -maxdepth 3 -name node -type f -print -quit 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  return 1
}
task_find_nvm() {
  local candidate
  for candidate in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" "$HOME/.nvm/nvm.sh" "${XDG_CONFIG_HOME:-$HOME/.config}/nvm/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
    if [ -s "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  done
  return 1
}
task_load_nvm() {
  local script="$1" had_nounset=0 result=0
  case $- in *u*) had_nounset=1; set +u ;; esac
  unset npm_config_prefix NPM_CONFIG_PREFIX
  # Auto-use would select the user's old default (e.g. 18) over a valid system 26.
  if . "$script" --no-use; then result=0; else result=$?; fi
  if [ "$had_nounset" = 1 ]; then set -u; fi
  return "$result"
}
task_nvm() {
  local had_nounset=0 result=0
  case $- in *u*) had_nounset=1; set +u ;; esac
  if nvm "$@"; then result=0; else result=$?; fi
  if [ "$had_nounset" = 1 ]; then set -u; fi
  return "$result"
}
task_install_nvm() {
  local installer result=0
  installer="$(mktemp -t wecom-nvm-install.XXXXXX)" || return 1
  if /usr/bin/curl --fail --location --retry 2 --connect-timeout 20 --max-time 300 \
      --proto '=https' https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh -o "$installer"; then
    # Keep existing shell profiles and global Node versions unchanged.
    if PROFILE=/dev/null /bin/bash "$installer"; then result=0; else result=$?; fi
  else result=$?; fi
  rm -f "$installer"
  return "$result"
}
task_select_node() {
  local project="$1" mode="${2:-check}" required candidate version='unavailable' nvm_script brew_path
  required="$(cat "$project/.nvmrc")" || return 1
  case "$required" in 24) ;; *) printf '无效的项目 Node 版本：%s\n' "$required" >&2; return 1 ;; esac
  candidate="$(task_find_node || true)"
  if [ -n "$candidate" ]; then
    version="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || version='unavailable'
    printf '检测到 Node：%s（%s）\n' "$version" "$candidate"
  fi
  if [ "${version%%.*}" != "$required" ]; then
    nvm_script="$(task_find_nvm || true)"
    if [ -n "$candidate" ]; then
      if [ -z "$nvm_script" ] && [ "$mode" = install ]; then
        printf '%s\n' '已有 Node 版本不匹配，安装 nvm 以选择项目版本。'
        task_install_nvm || return 1
        nvm_script="$(task_find_nvm || true)"
      fi
      if [ -n "$nvm_script" ]; then
        task_load_nvm "$nvm_script" || return 1
        if ! task_nvm use --silent "$required"; then
          if [ "$mode" != install ]; then
            printf 'nvm 中缺少 Node %s；当前检测为 %s（%s）。请在项目根目录运行 npm run setup 补装。\n' "$required" "$version" "${candidate:-not-found}" >&2
            return 1
          fi
          task_nvm install "$required" || return 1
          task_nvm use --silent "$required" || return 1
        fi
        candidate="$(command -v node)"
      elif [ -n "$candidate" ]; then
        printf '项目要求 Node %s，实际为 %s（%s）；未找到 nvm，请在项目根目录运行 npm run setup。\n' "$required" "$version" "$candidate" >&2
        return 1
      fi
    fi
    if [ -z "$candidate" ]; then
      if [ "$mode" != install ]; then printf '未找到 Node；请运行 bash install-dependencies.sh 安装 Node %s。\n' "$required" >&2; return 1; fi
      brew_path="${task_brew:-}"
      if [ -z "$brew_path" ]; then printf '%s\n' '未找到 Homebrew，无法安装 Node。https://brew.sh/' >&2; return 1; fi
      "$brew_path" install "node@$required" || return 1
      candidate="$("$brew_path" --prefix "node@$required")/bin/node"
    fi
  fi
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || {
    printf 'Node 无法运行：%s；请检查安装或动态库错误。\n' "$candidate" >&2; return 1;
  }
  if [ "${version%%.*}" != "$required" ]; then printf 'Node 选择失败：要求 %s，实际 %s（%s）。\n' "$required" "$version" "$candidate" >&2; return 1; fi
  task_node="$candidate"
  task_node_bin="$(dirname "$candidate")"
  export PATH="$task_node_bin:$PATH"
  if [ ! -x "$task_node_bin/npm" ]; then printf 'Node %s 的 npm 缺失：%s/npm\n' "$version" "$task_node_bin" >&2; return 1; fi
  printf '项目使用 Node %s（%s）；npm：%s/npm\n' "$version" "$task_node" "$task_node_bin"
}
