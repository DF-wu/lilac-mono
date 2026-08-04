#!/usr/bin/env bash
# Runs a Telegram-only Lilac runtime alongside an existing deployment, without
# touching it.
#
# Isolation:
#   - a separate Redis logical db, so the two event buses share no keyspace
#   - its own named volume for /data
#   - no published ports
#   - Discord allowlists emptied, so this instance ignores all Discord traffic
#     (see apps/core/src/surface/discord/discord-channel-guards.ts: both lists
#     empty means every message is rejected)
#
# The Telegram token is copied into the derived verification config. The
# temporary named volume contains secret material and must be removed with the
# stop command after verification.
#
# Usage:
#   docker/telegram-verify-stack.sh start
#   docker/telegram-verify-stack.sh logs
#   docker/telegram-verify-stack.sh stop
#
# Environment overrides:
#   REF_CONTAINER    container to copy configuration from (default lilac-mono-catalina)
#   REDIS_DB         logical db for the verification bus (default 15)
#   TELEGRAM_CHAT_ID chat id to allowlist (required on first start)
#   IMAGE            image to run (default lilac-mono:telegram-verify)
#   KEY_MODE         all | minimal | none  (default all)
set -euo pipefail

REF_CONTAINER="${REF_CONTAINER:-lilac-mono-catalina}"
REDIS_DB="${REDIS_DB:-15}"
IMAGE="${IMAGE:-lilac-mono:telegram-verify}"
KEY_MODE="${KEY_MODE:-all}"
NAME="lilac-telegram-verify"
VOLUME="lilac-telegram-verify-data"

# Provider credentials the agent needs to actually answer.
MINIMAL_KEYS=(
  ANTHROPIC_API_KEY OPENAI_API_KEY OPENAI_BASE_URL
)
# Everything else the reference container carries, minus the runtime-specific
# values this script sets itself.
EXCLUDED_KEYS=(
  PATH HOME HOSTNAME REDIS_URL DATA_DIR
  LL_TOOL_SERVER_PORT GITHUB_WEBHOOK_PORT
)

die() {
  echo "error: $*" >&2
  exit 1
}

require_ref() {
  docker inspect "${REF_CONTAINER}" >/dev/null 2>&1 ||
    die "reference container '${REF_CONTAINER}' is not running"
}

ref_env() {
  docker inspect "${REF_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}'
}

ref_network() {
  docker inspect "${REF_CONTAINER}" \
    --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -1
}

# Emits `-e KEY=VALUE` arguments on stdout, NUL-separated so values containing
# spaces survive.
build_env_args() {
  local mode="$1"
  ref_env | while IFS= read -r line; do
    [ -n "${line}" ] || continue
    local key="${line%%=*}"

    for excluded in "${EXCLUDED_KEYS[@]}"; do
      [ "${key}" = "${excluded}" ] && continue 2
    done

    case "${mode}" in
      none) continue ;;
      minimal)
        local keep=0
        for wanted in "${MINIMAL_KEYS[@]}"; do
          [ "${key}" = "${wanted}" ] && keep=1
        done
        # Always carry non-secret runtime settings such as TZ.
        case "${key}" in TZ | LANG | LC_*) keep=1 ;; esac
        [ "${keep}" = "1" ] || continue
        ;;
    esac

    printf -- '-e\0%s\0' "${line}"
  done
}

seed_config() {
  local chat_id="$1"
  # Copy the live config verbatim and override only what would make the
  # parallel instance act twice. Everything else — prompts, models, tools,
  # entity aliases — is preserved so the verification run behaves like the
  # real deployment.
  docker exec "${REF_CONTAINER}" sh -c 'cat /data/core-config.yaml' |
    bun "$(dirname "${BASH_SOURCE[0]}")/telegram-verify-config.ts" "${chat_id}" "${TELEGRAM_API_ROOT:-}"
}

cmd_start() {
  require_ref
  [ -n "${TELEGRAM_CHAT_ID:-}" ] || die "set TELEGRAM_CHAT_ID to the chat you want to allowlist"
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "image '${IMAGE}' not built"

  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  docker volume create "${VOLUME}" >/dev/null

  local network
  network="$(ref_network)"
  [ -n "${network}" ] || die "could not determine the reference container's network"

  local redis_host
  redis_host="$(ref_env | sed -n 's|^REDIS_URL=redis://||p' | cut -d/ -f1)"
  [ -n "${redis_host}" ] || die "could not determine the redis host"

  echo "==> reference : ${REF_CONTAINER}"
  echo "==> network   : ${network}"
  echo "==> bus       : redis://${redis_host}/${REDIS_DB}  (isolated from the live bus)"
  echo "==> keys      : ${KEY_MODE}"
  echo "==> chat      : ${TELEGRAM_CHAT_ID}"
  echo

  local env_args=()
  while IFS= read -r -d '' arg; do env_args+=("${arg}"); done < <(build_env_args "${KEY_MODE}")

  docker run -d \
    --name "${NAME}" \
    --network "${network}" \
    --restart no \
    "${env_args[@]}" \
    -e "REDIS_URL=redis://${redis_host}/${REDIS_DB}" \
    -e "DATA_DIR=/data" \
    -v "${VOLUME}:/data" \
    "${IMAGE}" >/dev/null

  # Seed the config, then restart so the runtime reads it on boot.
  seed_config "${TELEGRAM_CHAT_ID}" | docker exec -i "${NAME}" sh -c 'cat > /data/core-config.yaml'
  docker restart "${NAME}" >/dev/null

  echo "==> started. follow with: docker/telegram-verify-stack.sh logs"
  echo "==> the live stack was not modified."
}

cmd_logs() {
  docker logs -f "${NAME}"
}

cmd_stop() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
  echo "==> stopped and removed. nothing left behind."
  echo "==> stop this before deploying Telegram for real: two pollers on one"
  echo "    bot token produce 409 Conflict."
}

case "${1:-}" in
  start) cmd_start ;;
  logs) cmd_logs ;;
  stop) cmd_stop ;;
  *)
    echo "usage: $0 {start|logs|stop}" >&2
    exit 2
    ;;
esac
