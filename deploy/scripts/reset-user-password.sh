#!/usr/bin/env bash
# Reset password for an existing production CRM user (by login).
#
# Credentials via ephemeral env vars only — never pass password as a CLI argument.
#
# Required:
#   CONFIRM_PRODUCTION_PASSWORD_RESET=YES
#   RESET_USER_LOGIN
#   RESET_USER_PASSWORD
# Optional:
#   ERP_ENV_FILE=/etc/erpbuket1/production.env
#
# Example (password via silent prompt):
#   read -r -s -p 'New password: ' RESET_USER_PASSWORD; echo
#   CONFIRM_PRODUCTION_PASSWORD_RESET=YES \
#   RESET_USER_LOGIN='operator' \
#   RESET_USER_PASSWORD="$RESET_USER_PASSWORD" \
#     ./deploy/scripts/reset-user-password.sh
#   unset RESET_USER_PASSWORD

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

if [[ "${CONFIRM_PRODUCTION_PASSWORD_RESET:-}" != "YES" ]]; then
  echo "Refusing: set CONFIRM_PRODUCTION_PASSWORD_RESET=YES" >&2
  exit 1
fi

: "${RESET_USER_LOGIN:?RESET_USER_LOGIN is required}"
: "${RESET_USER_PASSWORD:?RESET_USER_PASSWORD is required}"

echo "[reset-password] updating password for login=${RESET_USER_LOGIN}"

erpbuket1_compose run --rm \
  -e CONFIRM_PRODUCTION_PASSWORD_RESET \
  -e RESET_USER_LOGIN \
  -e RESET_USER_PASSWORD \
  api \
  node dist/reset-user-password.js

echo "[reset-password] done"
