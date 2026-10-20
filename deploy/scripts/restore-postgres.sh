#!/usr/bin/env bash
# Restore an erpbuket1 pg_dump (-Fc) into a TARGET database inside ERP postgres.
#
# SAFETY:
#   - CONFIRM_RESTORE=YES required
#   - TARGET_DB required (SQL identifier validated)
#   - Refuses shop-like / ambiguous DB names
#   - Refuses TARGET_DB equal to production POSTGRES_DB unless
#       CONFIRM_PRODUCTION_RESTORE=YES I_UNDERSTAND_DESTRUCTIVE_RESTORE=YES
#   - Takes a safety backup of current production DB before destructive restore
#   - Never runs automatically from deploy/install
#   - Does not touch shopbuket1 compose/volumes
#
# Test restore (preferred):
#   # create disposable DB once:
#   ERP_ENV_FILE=/etc/erpbuket1/production.env \
#     docker compose --env-file "$ERP_ENV_FILE" -f docker-compose.prod.yml --project-name erpbuket1 \
#       exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" flower_crm_restore_test || true'
#   TARGET_DB=flower_crm_restore_test CONFIRM_RESTORE=YES \
#     ./deploy/scripts/restore-postgres.sh /var/backups/erpbuket1/erpbuket1_YYYYMMDDTHHMMSSZ.dump
#
# Production overwrite (incident only):
#   TARGET_DB=flower_crm CONFIRM_RESTORE=YES \
#   CONFIRM_PRODUCTION_RESTORE=YES I_UNDERSTAND_DESTRUCTIVE_RESTORE=YES \
#     ./deploy/scripts/restore-postgres.sh /var/backups/erpbuket1/erpbuket1_....dump

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

SERVICE="${POSTGRES_SERVICE:-postgres}"
DUMP_FILE="${1:-}"

log() { echo "[restore] $*" >&2; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

is_safe_sql_ident() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && ((${#1} <= 63))
}

looks_like_shop_db() {
  local n
  n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${n}" in
    shopbuket1|shop_*|*woocommerce*|*magento*|*opencart*|mysql|mariadb)
      return 0
      ;;
  esac
  # Explicit shop compose project DB names sometimes used on HostFly
  if [[ "${n}" == *shopbuket* ]]; then
    return 0
  fi
  return 1
}

if [[ -z "${DUMP_FILE}" ]]; then
  die "Usage: CONFIRM_RESTORE=YES TARGET_DB=<db> $0 /path/to/erpbuket1_....dump"
fi
[[ -f "${DUMP_FILE}" ]] || die "dump file not found: ${DUMP_FILE}"
[[ -s "${DUMP_FILE}" ]] || die "dump file is empty: ${DUMP_FILE}"

if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  die "set CONFIRM_RESTORE=YES to proceed"
fi
[[ -n "${TARGET_DB:-}" ]] || die "set TARGET_DB explicitly (e.g. flower_crm_restore_test)"

is_safe_sql_ident "${TARGET_DB}" || die "TARGET_DB must be a plain SQL identifier [A-Za-z_][A-Za-z0-9_]*"
if looks_like_shop_db "${TARGET_DB}"; then
  die "TARGET_DB '${TARGET_DB}' looks like a shop database — refusing (ERP restore only)"
fi

erpbuket1_require_env_file
erpbuket1_validate_env
erpbuket1_check_docker

# Refuse ambiguous ERP state
db_state="$(erpbuket1_detect_db_state)"
case "${db_state}" in
  existing) ;;
  lost_volume)
    die "LOST VOLUME — cannot restore until ${ERP_VOLUME_NAME} is recovered (see docs/deployment.md)"
    ;;
  interrupted_first_install)
    die "no postgres volume yet — finish install (or recover volume) before restore"
    ;;
  ambiguous_volume_without_env)
    die "ambiguous state (volume without env) — fix production.env first"
    ;;
  fresh)
    die "no ERP env/volume — install ERP first, then restore into a disposable TARGET_DB"
    ;;
  *)
    die "refusing restore in state=${db_state}"
    ;;
esac

prod_db="$(erpbuket1_env_get POSTGRES_DB)"
[[ -n "${prod_db}" ]] || die "POSTGRES_DB empty in env"
is_safe_sql_ident "${prod_db}" || die "POSTGRES_DB in env is not a safe identifier"

magic="$(head -c 5 "${DUMP_FILE}" 2>/dev/null || true)"
[[ "${magic}" == "PGDMP" ]] || die "file is not a pg_dump custom-format dump (expected PGDMP magic)"

if ! erpbuket1_postgres_service_running; then
  die "postgres service not running; start it first (./deploy/scripts/deploy.sh or compose up -d postgres)"
fi

# Destructive production restore needs extra gates + pre-backup
if [[ "${TARGET_DB}" == "${prod_db}" ]]; then
  if [[ "${CONFIRM_PRODUCTION_RESTORE:-}" != "YES" || "${I_UNDERSTAND_DESTRUCTIVE_RESTORE:-}" != "YES" ]]; then
    die "TARGET_DB equals production POSTGRES_DB (${prod_db}). Set CONFIRM_PRODUCTION_RESTORE=YES and I_UNDERSTAND_DESTRUCTIVE_RESTORE=YES, or restore into a test DB first."
  fi
  log "PRODUCTION restore requested — taking safety backup first"
  BACKUP_DIR="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}" \
    "${SCRIPT_DIR}/backup-postgres.sh" || die "safety backup failed — aborting restore"
fi

log "target database: ${TARGET_DB}"
log "dump: ${DUMP_FILE}"
log "compose project: ${ERP_COMPOSE_PROJECT}"
log "THIS WILL DROP AND RECREATE OBJECTS IN ${TARGET_DB}"

# Ensure target DB exists (createdb is idempotent-ish)
erpbuket1_compose exec -T "${SERVICE}" \
  sh -c "createdb -U \"\$POSTGRES_USER\" \"${TARGET_DB}\" 2>/dev/null || true"

# Terminate sessions on target
erpbuket1_compose exec -T "${SERVICE}" \
  sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid();\"" \
  || true

# Restore (TARGET_DB validated as identifier — safe in this quoted form)
if ! cat "${DUMP_FILE}" | erpbuket1_compose exec -T "${SERVICE}" \
  sh -c "pg_restore -U \"\$POSTGRES_USER\" -d \"${TARGET_DB}\" --clean --if-exists --no-owner --no-acl"; then
  die "pg_restore failed — inspect DB state before retrying; production safety backup (if any) is still in ${ERP_BACKUP_DIR_DEFAULT}"
fi

log "completed into ${TARGET_DB}"
log "Verify tables, then point app at this DB only if intentional."
log "Example: docker compose ... exec -T postgres psql -U \"\$POSTGRES_USER\" -d ${TARGET_DB} -c '\\dt'"
exit 0
