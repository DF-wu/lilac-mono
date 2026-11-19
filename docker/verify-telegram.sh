#!/usr/bin/env bash
# Runs the Telegram surface suite inside a throwaway container.
#
# The suite drives the real TelegramAdapter against a local fake Bot API server,
# so this never reaches api.telegram.org and needs no bot token. Running it in a
# container proves it also passes on a clean Linux userspace rather than only on
# the developer's machine.
#
# Nothing is written to the host: the repo is mounted read-only and the test
# scratch directory lives in a container-local tmpfs.
#
# Usage:
#   docker/verify-telegram.sh            # telegram suite
#   docker/verify-telegram.sh tests/     # any path under apps/core
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PATH="${1:-tests/surface/telegram/}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.14}"

echo "==> repo:  ${REPO_ROOT}"
echo "==> image: ${BUN_IMAGE}"
echo "==> tests: apps/core/${TEST_PATH}"
echo

# --network none proves the suite has no hidden dependency on the real Bot API.
# The fake server binds to loopback, which still works without external networking.
docker run --rm \
  --network none \
  --workdir /repo/apps/core \
  --mount "type=bind,source=${REPO_ROOT},target=/repo,readonly" \
  --tmpfs /tmp:exec \
  --tmpfs /home/bun:exec \
  --env HOME=/home/bun \
  --env DATA_DIR=/tmp/lilac-data \
  "${BUN_IMAGE}" \
  bun test "${TEST_PATH}"

echo
echo "==> telegram suite passed in an isolated container"
