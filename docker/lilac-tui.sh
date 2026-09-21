#!/bin/sh
set -eu
cd /app/apps/tui
exec /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-}" LANG="${LANG:-C.UTF-8}" /usr/local/bin/bun --preload @opentui/solid/preload /app/apps/tui/src/main.ts "$@"
