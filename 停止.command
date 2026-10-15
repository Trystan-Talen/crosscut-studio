#!/bin/bash
set -u
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
node scripts/launcher.mjs stop
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ] && [ "${CROSSCUT_NONINTERACTIVE:-0}" != 1 ]; then read -r -p '停止未完成，按回车关闭…' _; fi
exit "$result"
