#!/bin/bash
set -u
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
node scripts/launcher.mjs backup
result=$?
if [ -t 0 ] && [ "${CROSSCUT_NONINTERACTIVE:-0}" != 1 ]; then read -r -p '按回车关闭…' _; fi
exit "$result"
