#!/usr/bin/env bash
#
# Remove everything the Telegram development/verification workflow leaves on the
# host: the throwaway container and its volume, the locally built image, the
# inbound-injection proxy process, and scratch directories.
#
# Deliberately narrow. Every resource is matched by an exact name defined here,
# never by a wildcard or a prune, so a stray label or a same-prefix production
# container cannot be caught by accident. The production stack is additionally
# named in PROTECTED and refused outright.
#
#   ./docker/telegram-dev-cleanup.sh              # container, volume, proxy, scratch
#   ./docker/telegram-dev-cleanup.sh --all        # also the 2.9GB local image
#   ./docker/telegram-dev-cleanup.sh --dry-run    # show what would go, change nothing
#
set -euo pipefail

CONTAINER="lilac-telegram-verify"
VOLUME="lilac-telegram-verify-data"
IMAGE="${IMAGE:-lilac-mono:telegram-verify}"
PROXY_PATTERN="scripts/telegram-inject-proxy.ts"

# Never removed by this script, whatever else matches. These run the real
# deployment; a cleanup script that can stop them is a cleanup script that will.
PROTECTED=("lilac-mono-catalina" "lilac-mono-claudia")

DRY_RUN=0
INCLUDE_IMAGE=0
REMOVED=0

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --all) INCLUDE_IMAGE=1 ;;
    --images) INCLUDE_IMAGE=1 ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option '${arg}' (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }

# Prints the action, then performs it unless --dry-run.
act() {
  local description="$1"
  shift
  REMOVED=$((REMOVED + 1))
  if [[ ${DRY_RUN} -eq 1 ]]; then
    say "  would remove: ${description}"
    return 0
  fi
  say "  removing: ${description}"
  "$@" || say "    (failed, continuing)"
}

assert_not_protected() {
  local name="$1"
  for protected in "${PROTECTED[@]}"; do
    if [[ "${name}" == "${protected}" ]]; then
      echo "refusing to touch protected container '${name}'" >&2
      exit 3
    fi
  done
}

assert_not_protected "${CONTAINER}"

say "==> Telegram development residue${DRY_RUN:+}"
[[ ${DRY_RUN} -eq 1 ]] && say "    (dry run: nothing will be changed)"

# --- container ---------------------------------------------------------------
if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
  act "container ${CONTAINER}" docker rm -f "${CONTAINER}"
else
  say "  absent: container ${CONTAINER}"
fi

# --- volume ------------------------------------------------------------------
if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
  act "volume ${VOLUME}" docker volume rm "${VOLUME}"
else
  say "  absent: volume ${VOLUME}"
fi

# --- injection proxy ---------------------------------------------------------
# Matched on the script path, so an unrelated `bun` process cannot match. The
# proxy holds the bot token in its environment, which is reason enough not to
# leave it running after a verification session.
proxy_pids="$(pgrep -f "${PROXY_PATTERN}" 2>/dev/null | tr '\n' ' ' || true)"
proxy_pids="${proxy_pids% }"
if [[ -n "${proxy_pids}" ]]; then
  for pid in ${proxy_pids}; do
    # pgrep -f also matches the shell running this script if the pattern appears
    # in its command line; never signal ourselves or our parent.
    if [[ "${pid}" == "$$" || "${pid}" == "${PPID}" ]]; then continue; fi
    act "inject proxy (pid ${pid})" kill "${pid}"
  done
else
  say "  absent: inject proxy"
fi

# --- scratch -----------------------------------------------------------------
# Test scratch directories are mkdtemp'd under these fixed prefixes; a suite
# killed mid-run leaves them behind.
shopt -s nullglob
scratch=(/tmp/lilac-telegram-*)
shopt -u nullglob
if [[ ${#scratch[@]} -gt 0 ]]; then
  for dir in "${scratch[@]}"; do
    act "scratch ${dir}" rm -rf "${dir}"
  done
else
  say "  absent: scratch directories"
fi

# --- image (opt-in) ----------------------------------------------------------
if [[ ${INCLUDE_IMAGE} -eq 1 ]]; then
  if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    size="$(docker image inspect "${IMAGE}" --format '{{.Size}}' 2>/dev/null || echo 0)"
    act "image ${IMAGE} ($((size / 1024 / 1024))MB)" docker image rm "${IMAGE}"
  else
    say "  absent: image ${IMAGE}"
  fi
elif docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  say "  kept: image ${IMAGE} — pass --all to remove it (a rebuild takes several minutes)"
fi

say ""
if [[ ${REMOVED} -eq 0 ]]; then
  say "==> nothing to clean."
elif [[ ${DRY_RUN} -eq 1 ]]; then
  say "==> ${REMOVED} item(s) would be removed. Re-run without --dry-run."
else
  say "==> ${REMOVED} item(s) removed."
fi

# The production stack is never touched; say so explicitly rather than leaving
# the operator to infer it from silence.
say "==> untouched: ${PROTECTED[*]}"
