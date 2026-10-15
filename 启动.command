#!/bin/bash
set -u
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
if ! command -v node >/dev/null 2>&1; then
  echo '未找到 Node.js。请从 https://nodejs.org/ 安装 22.22 或更高版本，再双击启动。'
  exit 1
fi
node scripts/launcher.mjs start
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ] && [ "${CROSSCUT_NONINTERACTIVE:-0}" != 1 ]; then
  read -r -p '请保留上面的错误信息。按回车关闭…' _
fi
exit "$result"
