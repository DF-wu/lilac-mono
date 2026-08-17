#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'image verification failed: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is unavailable"
docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon"
[[ $# -le 3 ]] || fail "usage: $0 [IMAGE [EXPECTED_USER [EXPECTED_UID]]]"

readonly image=${1:-lilac:dev}
readonly expected_user=${2:-lilac}
readonly expected_uid=${3:-1000}
container_name="lilac-image-verify-$(date +%s)-$$-${RANDOM}"
readonly container_name
readonly log_marker="lilac-direct-output-${container_name}"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker image inspect "$image" >/dev/null 2>&1 || fail "image does not exist: $image"

docker run --detach \
  --name "$container_name" \
  --network none \
  --tmpfs /run:rw,nosuid,nodev,mode=755,size=64m \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=1g \
  --memory 4g \
  --pids-limit 1024 \
  --stop-timeout 30 \
  --no-healthcheck \
  --env LILAC_USER=runtime-override-must-not-win \
  --env LILAC_UID=9999 \
  --env LILAC_GID=9999 \
  --env HOME=/tmp/runtime-override-must-not-win \
  --env USER=runtime-override-must-not-win \
  --env LOGNAME=runtime-override-must-not-win \
  --env LILAC_VERIFY_LOG_MARKER="$log_marker" \
  "$image" \
  /bin/sh -c '(/bin/sleep 0.1 &); /usr/bin/env | /usr/bin/sort >/tmp/lilac-service-env; /bin/sleep 1; printf "%s\n" "$LILAC_VERIFY_LOG_MARKER"; printf "%s" "$LILAC_OPERATOR_TOKEN_SHA256" >/tmp/lilac-service-token-hash; exec /bin/sleep infinity' \
  >/dev/null

readonly wait_deadline=$((SECONDS + 30))
ready=false
while ((SECONDS < wait_deadline)); do
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  if [[ $running != true ]]; then
    exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container_name" 2>/dev/null || true)
    fail "smoke container exited early (exit ${exit_code:-unknown})"
  fi
  if docker exec "$container_name" /usr/bin/test -s /tmp/lilac-service-token-hash; then
    ready=true
    break
  fi
  sleep 1
done
[[ $ready == true ]] || fail "timed out waiting for the entrypoint"

runtime_user=$(docker exec "$container_name" /usr/bin/cat /etc/lilac-runtime-user)
[[ $runtime_user == "$expected_user" ]] ||
  fail "runtime user is $runtime_user, expected $expected_user"
identity_metadata=$(docker exec "$container_name" /usr/bin/stat --format='%a:%u:%g' /etc/lilac-runtime-user)
[[ $identity_metadata == 444:0:0 ]] ||
  fail "runtime identity is not root:root mode 0444"
runtime_uid=$(docker exec "$container_name" /usr/bin/id -u "$runtime_user")
runtime_gid=$(docker exec "$container_name" /usr/bin/id -g "$runtime_user")
[[ $runtime_uid == "$expected_uid" ]] ||
  fail "runtime UID is $runtime_uid, expected $expected_uid"
[[ $runtime_gid == "$expected_uid" ]] ||
  fail "runtime GID is $runtime_gid, expected $expected_uid"
runtime_home=$(docker exec "$container_name" /usr/bin/getent passwd "$runtime_user" | /usr/bin/cut -d: -f6)
readonly expected_home="/home/$expected_user"
[[ $runtime_home == "$expected_home" ]] ||
  fail "passwd home is $runtime_home, expected $expected_home"
home_metadata=$(docker exec "$container_name" /usr/bin/stat --format='%u:%g' "$runtime_home")
[[ $home_metadata == "$expected_uid:$expected_uid" ]] ||
  fail "runtime home ownership is $home_metadata, expected $expected_uid:$expected_uid"
if [[ $expected_user == Catalina ]]; then
  catalinna_target=$(docker exec "$container_name" /usr/bin/readlink /home/Catalinna)
  [[ $catalinna_target == /home/Catalina ]] ||
    fail "Catalina compatibility home does not target /home/Catalina"
elif docker exec "$container_name" /usr/bin/test -e /home/Catalinna; then
  fail "Catalina compatibility home exists in the $expected_user image"
fi
pid1_uid=$(docker exec "$container_name" /usr/bin/stat --format='%u' /proc/1)
[[ $pid1_uid == 0 ]] || fail "PID 1 does not run as root"
pid1_name=$(docker exec "$container_name" /usr/bin/cat /proc/1/comm)
[[ $pid1_name == tini ]] || fail "PID 1 is not tini (found $pid1_name)"
service_pids=$(docker exec "$container_name" /usr/bin/cat /proc/1/task/1/children)
[[ $service_pids =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]] ||
  fail "tini did not reap the orphan probe (children: $service_pids)"
service_pid=${BASH_REMATCH[1]}
service_uid=$(docker exec "$container_name" /usr/bin/stat --format='%u' "/proc/$service_pid")
[[ $service_uid == "$runtime_uid" ]] || fail "service process does not run as $runtime_user"
service_name=$(docker exec "$container_name" /bin/sh -c "tr '\0' ' ' </proc/$service_pid/cmdline")
[[ $service_name == "/bin/sleep infinity " ]] || fail "unexpected service command: $service_name"
service_env=$(docker exec "$container_name" /usr/bin/cat /tmp/lilac-service-env)
for expected_env in \
  "LILAC_USER=$expected_user" \
  "LILAC_UID=$expected_uid" \
  "LILAC_GID=$expected_uid" \
  "HOME=$expected_home" \
  "USER=$expected_user" \
  "LOGNAME=$expected_user"; do
  grep -Fxq "$expected_env" <<<"$service_env" ||
    fail "service environment does not contain $expected_env"
done
service_path=$(grep -F 'PATH=' <<<"$service_env" | cut -d= -f2-)
[[ :$service_path: == *":$expected_home/.local/bin:"* ]] ||
  fail "service PATH does not include $expected_home/.local/bin"
[[ :$service_path: == *":$expected_home/.bun/bin:"* ]] ||
  fail "service PATH does not include $expected_home/.bun/bin"

token_metadata=$(docker exec "$container_name" /usr/bin/stat --format='%a:%u:%g' \
  /run/lilac/operator-token)
[[ $token_metadata == 600:0:0 ]] || fail "operator token is not root:root mode 0600"
if docker exec --user "$runtime_user" "$container_name" /usr/bin/test -r /run/lilac/operator-token; then
  fail "operator token is readable by $runtime_user"
fi
docker exec "$container_name" /bin/sh -c \
  'hash=$(/usr/bin/sha256sum /run/lilac/operator-token | /usr/bin/cut -d " " -f 1); test "$(/usr/bin/cat /tmp/lilac-service-token-hash)" = "$hash"' ||
  fail "operator token hash was not propagated to the service process"

resolved_tools=$(docker exec "$container_name" /bin/sh -c 'command -v tools')
[[ $resolved_tools == /usr/local/bin/tools ]] || fail "root PATH does not select trusted tools CLI"
docker exec "$container_name" /usr/local/bin/tools --help >/dev/null || fail "tools CLI smoke failed"
operator_status=0
operator_output=$(docker exec \
  --env TOOL_SERVER_BACKEND_URL=http://127.0.0.1:1 \
  "$container_name" /usr/local/bin/tools --operator --list 2>&1) || operator_status=$?
[[ $operator_status -ne 0 && $operator_output == "Error: fetch tools list failed" ]] ||
  fail "operator CLI did not load its token before the expected connection failure"
docker exec --user "$runtime_user" "$container_name" /usr/local/bin/bun --version >/dev/null ||
  fail "Bun smoke failed"

for path in /app /usr/local/bin/bun /usr/local/libexec/lilac-tool-bridge; do
  if docker exec --user "$runtime_user" "$container_name" /usr/bin/test -w "$path"; then
    fail "$path is writable by $runtime_user"
  fi
done
docker exec --user "$runtime_user" "$container_name" /usr/bin/test -w /data ||
  fail "/data is not writable by $runtime_user"

container_logs=$(docker logs "$container_name" 2>&1)
[[ $container_logs == *"$log_marker"* ]] || fail "direct process output is absent from Docker logs"

docker kill --signal TERM "$container_name" >/dev/null
readonly stop_deadline=$((SECONDS + 10))
while ((SECONDS < stop_deadline)); do
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  [[ $running == false ]] && break
  sleep 1
done
[[ $running == false ]] || fail "container did not stop after SIGTERM"
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container_name")
[[ $exit_code == 143 ]] || fail "unexpected exit code after SIGTERM: $exit_code"

printf 'image verification passed\n'
