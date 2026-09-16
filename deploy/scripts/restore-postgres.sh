#!/usr/bin/env bash
# Restore NewERP PostgreSQL dump into a TARGET database.
#
# SAFETY: refuses to run unless CONFIRM_RESTORE=YES and TARGET_DB is set.
# Never silently overwrites production. Prefer restoring into a disposable DB first.
#
# Example — test restore into a disposable database:
#   docker compose -f docker-compose.prod.yml exec -T postgres \
#     sh -c 'createdb -U "$POSTGRES_USER" flower_crm_restore_test || true'
#   TARGET_DB=flower_crm_restore_test CONFIRM_RESTORE=YES \
#     ./deploy/scripts/restore-postgres.sh /opt/backups/postgres/newerp_YYYYMMDD.dump
#
# Production overwrite (incident only):
#   TARGET_DB=flower_crm CONFIRM_RESTORE=YES \
#     ./deploy/scripts/restore-postgres.sh /path/to/dump.dump
#
# After restore into production: redeploy matching app version and run migrate deploy if needed.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.prod.yml}"
SERVICE="${POSTGRES_SERVICE:-postgres}"
DUMP_FILE="${1:-}"

if [[ -z "${DUMP_FILE}" || ! -f "${DUMP_FILE}" ]]; then
  echo "Usage: CONFIRM_RESTORE=YES TARGET_DB=<name> $0 /path/to/newerp_....dump" >&2
  exit 1
fi

if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  echo "Refusing: set CONFIRM_RESTORE=YES to proceed." >&2
  exit 1
fi

if [[ -z "${TARGET_DB:-}" ]]; then
  echo "Refusing: set TARGET_DB explicitly (e.g. flower_crm_restore_test)." >&2
  exit 1
fi

echo "[restore] target database: ${TARGET_DB}"
echo "[restore] dump: ${DUMP_FILE}"
echo "[restore] THIS WILL DROP AND RECREATE OBJECTS IN ${TARGET_DB}"

# Drop connections and recreate schema objects via pg_restore --clean
docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" \
  sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'"'"${TARGET_DB}"'"'"'"' AND pid <> pg_backend_pid();"' \
  || true

cat "${DUMP_FILE}" | docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d '"${TARGET_DB}"' --clean --if-exists --no-owner --no-acl'

echo "[restore] completed into ${TARGET_DB}"
echo "[restore] Verify with: docker compose -f ${COMPOSE_FILE} exec -T postgres psql -U \"\$POSTGRES_USER\" -d ${TARGET_DB} -c '\\dt'"
