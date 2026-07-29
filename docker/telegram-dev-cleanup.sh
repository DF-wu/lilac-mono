#!/usr/bin/env bash
#
# Remove everything the Telegram development/verification workflow leaves on the
# host: the throwaway container and its volume, the locally built image, the
# inbound-injection proxy process, and scratch directories.
#
# Deliberately narrow, but not uniformly so. The container, the volume and the
# image are matched by exact name, and the production stack is named in
# PROTECTED and refused outright, so no prune or stray label can take the
# deployment down. Two targets cannot be exact-matched and are not: the proxy is
# found by its script path (its pid is not knowable in advance) and scratch
# directories are found by the mkdtemp prefixes below (their random suffixes are
# never recorded anywhere). Both are therefore prefix/pattern matches that can
# catch an equivalent resource belonging to a concurrent session — run
# --dry-run first if another verification run may be in flight.
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
ATTEMPTED=0
SUCCEEDED=0
FAILED=0
FAILURES=()

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --all) INCLUDE_IMAGE=1 ;;
    --images) INCLUDE_IMAGE=1 ;;
    -h | --help)
      # Print the header block verbatim rather than a second copy of it that can
      # drift: everything from the line after the shebang to the first line that
      # is not a comment.
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
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
#
# A failure here is not cosmetic: a kill that does not land leaves the inject
# proxy running with the bot token in its environment. So the outcome is
# recorded per item and reported at the end, and the script exits non-zero —
# reporting an attempt as a removal would tell the operator the token is gone
# when it is not. Failures still do not abort the run, because the remaining
# targets are independent and worth clearing.
act() {
  local description="$1"
  shift
  ATTEMPTED=$((ATTEMPTED + 1))
  if [[ ${DRY_RUN} -eq 1 ]]; then
    say "  would remove: ${description}"
    return 0
  fi
  say "  removing: ${description}"
  if "$@"; then
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILURES+=("${description}")
    say "    (FAILED, continuing)"
  fi
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
# The Telegram test suites mkdtemp under these four fixed prefixes; a suite
# killed mid-run leaves the directory behind. Listed individually rather than as
# a blanket /tmp/lilac-telegram-* so an unrelated directory that merely shares
# the project prefix is not swept up — note this still cannot distinguish *our*
# leftover from one belonging to a suite running right now, since mkdtemp's
# suffix is random and never recorded. Nothing removed here is recoverable, so
# --dry-run first if another run may be in flight.
SCRATCH_PREFIXES=(
  "/tmp/lilac-telegram-it-"
  "/tmp/lilac-telegram-menu-"
  "/tmp/lilac-telegram-e2e-"
  "/tmp/lilac-telegram-poll-"
)
shopt -s nullglob
scratch=()
for prefix in "${SCRATCH_PREFIXES[@]}"; do
  for dir in "${prefix}"*; do
    [[ -d "${dir}" ]] && scratch+=("${dir}")
  done
done
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
if [[ ${ATTEMPTED} -eq 0 ]]; then
  say "==> nothing to clean."
elif [[ ${DRY_RUN} -eq 1 ]]; then
  say "==> ${ATTEMPTED} item(s) would be removed. Re-run without --dry-run."
elif [[ ${FAILED} -eq 0 ]]; then
  say "==> ${SUCCEEDED} item(s) removed."
else
  say "==> ${SUCCEEDED} item(s) removed, ${FAILED} failed:"
  for failure in "${FAILURES[@]}"; do
    say "      - ${failure}"
  done
  say "    Residue remains; re-run or remove the above by hand."
fi

# The production stack is never touched; say so explicitly rather than leaving
# the operator to infer it from silence.
say "==> untouched: ${PROTECTED[*]}"

# Exit non-zero when anything failed, so a caller (or a CI step) is not told the
# host is clean while the inject proxy is still holding the bot token.
if [[ ${FAILED} -gt 0 ]]; then
  exit 1
fi
