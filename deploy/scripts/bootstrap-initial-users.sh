#!/usr/bin/env bash
# One-shot first DIRECTOR bootstrap for an EMPTY production database.
#
# Runs the compiled CLI inside the production API image (not development seed).
# Credentials must be supplied as ephemeral environment variables — never commit them.
#
# Required:
#   CONFIRM_PRODUCTION_BOOTSTRAP=YES
#   BOOTSTRAP_DIRECTOR_NAME
#   BOOTSTRAP_DIRECTOR_LOGIN
#   BOOTSTRAP_DIRECTOR_PASSWORD
# Optional:
#   BOOTSTRAP_DIRECTOR_EMAIL
#   ERP_ENV_FILE=/etc/erpbuket1/production.env
#
# Example:
#   CONFIRM_PRODUCTION_BOOTSTRAP=YES \
#   BOOTSTRAP_DIRECTOR_NAME='Иван Иванов' \
#   BOOTSTRAP_DIRECTOR_LOGIN='ivan' \
#   BOOTSTRAP_DIRECTOR_EMAIL='ivan@example.com' \
#   BOOTSTRAP_DIRECTOR_PASSWORD='your-strong-password' \
#   ./deploy/scripts/bootstrap-initial-users.sh

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

if [[ "${CONFIRM_PRODUCTION_BOOTSTRAP:-}" != "YES" ]]; then
  echo "Refusing: set CONFIRM_PRODUCTION_BOOTSTRAP=YES" >&2
  exit 1
fi

: "${BOOTSTRAP_DIRECTOR_NAME:?BOOTSTRAP_DIRECTOR_NAME is required}"
: "${BOOTSTRAP_DIRECTOR_LOGIN:?BOOTSTRAP_DIRECTOR_LOGIN is required}"
: "${BOOTSTRAP_DIRECTOR_PASSWORD:?BOOTSTRAP_DIRECTOR_PASSWORD is required}"

echo "[bootstrap] creating first DIRECTOR via production API CLI (one-shot)"

erpbuket1_compose run --rm \
  -e BOOTSTRAP_DIRECTOR_NAME \
  -e BOOTSTRAP_DIRECTOR_LOGIN \
  -e BOOTSTRAP_DIRECTOR_EMAIL \
  -e BOOTSTRAP_DIRECTOR_PASSWORD \
  api \
  node dist/bootstrap-director.js

echo "[bootstrap] done — change the password after first login if desired"
