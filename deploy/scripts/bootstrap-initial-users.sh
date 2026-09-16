#!/usr/bin/env bash
# One-shot initial users bootstrap for an EMPTY production database.
#
# Seed refuses NODE_ENV=production. This script runs seed in a controlled
# one-shot container with NODE_ENV=development against the production Postgres
# service — ONLY when CONFIRM_PRODUCTION_BOOTSTRAP=YES.
#
# After bootstrap: log in as director and change the password immediately.
# Never leave SEED_RESET_PASSWORDS=true on a production server.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

if [[ "${CONFIRM_PRODUCTION_BOOTSTRAP:-}" != "YES" ]]; then
  echo "Refusing: set CONFIRM_PRODUCTION_BOOTSTRAP=YES" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Refusing: missing .env" >&2
  exit 1
fi

echo "[bootstrap] running development seed once against production DB"
echo "[bootstrap] change director password immediately after first login"

# Compose injects DATABASE_URL for the migrate service from POSTGRES_*.
# Override NODE_ENV so seed is allowed; do not enable SEED_RESET_PASSWORDS.
docker compose -f docker-compose.prod.yml run --rm \
  -e NODE_ENV=development \
  -e SEED_RESET_PASSWORDS=false \
  --entrypoint pnpm \
  migrate \
  --filter @erp/database seed

echo "[bootstrap] done"
