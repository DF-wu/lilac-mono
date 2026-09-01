#!/bin/sh
set -eu

LILAC_OPERATOR_TOKEN_SHA256=$(
  /usr/bin/node /usr/local/libexec/create-operator-token.mjs
)
export LILAC_OPERATOR_TOKEN_SHA256

runtime_user=$(/usr/bin/cat /etc/lilac-runtime-user)
uid=$(/usr/bin/id -u "$runtime_user")
gid=$(/usr/bin/id -g "$runtime_user")
home=$(/usr/bin/getent passwd "$runtime_user" | /usr/bin/cut -d: -f6)
export LILAC_USER="$runtime_user"
export LILAC_UID="$uid"
export LILAC_GID="$gid"
export HOME="$home"
export USER="$runtime_user"
export LOGNAME="$runtime_user"

if [ "$#" -eq 2 ] && [ "$1" = "/usr/local/bin/bun" ] && [ "$2" = "apps/core/src/runtime/main.ts" ]; then
  if [ "${LILAC_AUTO_MIGRATE_BLOB_STORAGE:-1}" != "0" ]; then
    /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups -- \
      /usr/local/bin/bun apps/core/scripts/startup-blob-storage-migration.ts
  fi
fi

exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
