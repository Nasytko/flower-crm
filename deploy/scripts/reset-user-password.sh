#!/usr/bin/env bash
# Reset password for an existing production CRM user (by login).
#
# Credentials via ephemeral env vars only — never pass password as a CLI argument.
#
# Required:
#   CONFIRM_PRODUCTION_PASSWORD_RESET=YES
#   RESET_USER_LOGIN
#   RESET_USER_PASSWORD
#
# Example (password via silent prompt):
#   read -r -s -p 'New password: ' RESET_USER_PASSWORD; echo
#   CONFIRM_PRODUCTION_PASSWORD_RESET=YES \
#   RESET_USER_LOGIN='paulnasytko' \
#   RESET_USER_PASSWORD="$RESET_USER_PASSWORD" \
#     ./deploy/scripts/reset-user-password.sh
#   unset RESET_USER_PASSWORD

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

if [[ "${CONFIRM_PRODUCTION_PASSWORD_RESET:-}" != "YES" ]]; then
  echo "Refusing: set CONFIRM_PRODUCTION_PASSWORD_RESET=YES" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Refusing: missing .env" >&2
  exit 1
fi

: "${RESET_USER_LOGIN:?RESET_USER_LOGIN is required}"
: "${RESET_USER_PASSWORD:?RESET_USER_PASSWORD is required}"

echo "[reset-password] updating password for login=${RESET_USER_LOGIN}"

docker compose -f docker-compose.prod.yml run --rm \
  -e CONFIRM_PRODUCTION_PASSWORD_RESET \
  -e RESET_USER_LOGIN \
  -e RESET_USER_PASSWORD \
  api \
  node dist/reset-user-password.js

echo "[reset-password] done"
