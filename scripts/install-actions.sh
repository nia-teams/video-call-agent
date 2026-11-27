#!/bin/bash
# Installation actions are separate from the read-only probes for isolated testing.
task_step() {
  local task_label="$1" task_status
  shift
  printf '\n正在执行：%s\n' "$task_label"
  # Preserve the command's failure status even when its output is piped to tee.
  if "$@" 2>&1 | tee -a "$task_log_dir/$task_label.log"; then
    return 0
  else
    task_status=$?
    printf '执行失败：%s（退出码 %s），日志：%s/%s.log\n' "$task_label" "$task_status" "$task_log_dir" "$task_label" >&2
    return "$task_status"
  fi
}

task_retry() {
  local task_label="$1" task_attempt
  shift
  for task_attempt in 1 2 3; do
    printf '尝试 %s/3：%s\n' "$task_attempt" "$task_label"
    if task_step "$task_label" "$@"; then return 0; fi
  done
  return 1
}

task_install_npm() {
  local task_project="$1" task_cache
  # A newly created per-run cache bypasses root-owned ~/.npm and cached partial
  # downloads, without sudo, chown, or changing the user's global npm settings.
  task_cache="$(mktemp -d "$task_log_dir/npm-cache.XXXXXX")" || return 1
  printf '本次 npm 独立缓存：%s\n' "$task_cache"
  if task_retry 'npm-ci' npm --cache "$task_cache" --prefix "$task_project" ci --include=dev --fetch-retries=3 --fetch-timeout=120000; then
    return 0
  fi
  printf '%s\n' 'npm 依赖安装失败：查看 npm-ci.log；本次未使用 ~/.npm 缓存。' >&2
  if grep -Eq 'EACCES|EPERM|ENOTEMPTY' "$task_log_dir/npm-ci.log"; then
    printf '%s\n' '请检查报错路径：若位于 node_modules，检查该目录的所有者和写权限，并关闭其他 npm 安装进程后重试。不要使用 sudo npm ci。' >&2
  fi
  printf '%s\n' '不会修改锁文件或自动切换第三方镜像。npm 官方仓库：https://registry.npmjs.org/；Node.js 官网：https://nodejs.org/en/download' >&2
  return 1
}

task_install_app() {
  local task_cask="$1" task_app="$2" task_site="$3"
  if task_probe_app "/Applications/$task_app"; then
    printf '已安装且可执行，跳过：%s\n' "$task_app"
    return 0
  fi
  if [[ -e "/Applications/$task_app" ]]; then
    printf '应用存在但不完整，未自动覆盖：/Applications/%s\n' "$task_app" >&2
  elif [[ -n "$task_brew" ]] && task_retry "$task_cask-install" "$task_brew" install --cask --appdir=/Applications "$task_cask"; then
    if task_probe_app "/Applications/$task_app"; then return 0; fi
  fi
  printf '❌ %s 自动安装未完成；官方下载：%s\n' "$task_app" "$task_site" >&2
  if [[ "$task_cask" == wechatwork ]]; then
    printf '%s\n' '也可使用 Mac App Store：https://apps.apple.com/cn/app/企业微信/id1189898970?mt=12' >&2
  fi
  printf '%s\n' '手动下载并安装到 /Applications 后重新运行本脚本；现在继续安装其他依赖。' >&2
  # The final read-only checks determine success, rather than aborting other steps.
  return 0
}
