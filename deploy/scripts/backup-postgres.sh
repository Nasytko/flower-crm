#!/usr/bin/env bash
# Backup erpbuket1 PostgreSQL (compose project erpbuket1 only).
#
# Usage:
#   ./deploy/scripts/backup-postgres.sh
#   ./deploy/scripts/backup.sh          # thin alias
#   ERP_ENV_FILE=/etc/erpbuket1/production.env BACKUP_DIR=/var/backups/erpbuket1 \
#     ./deploy/scripts/backup-postgres.sh
#
# Optional prune (OFF by default — never deletes dumps unless explicitly confirmed):
#   PRUNE_BACKUPS=1 CONFIRM_BACKUP_PRUNE=YES RETENTION_DAYS=14 \
#     ./deploy/scripts/backup-postgres.sh
#
# IMPORTANT: On-VPS dumps are NOT disaster recovery. Copy off-box separately.
# Do NOT use shopbuket1 object storage without explicit agreement.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

SERVICE="${POSTGRES_SERVICE:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
MIN_KEEP_SUCCESSFUL="${MIN_KEEP_SUCCESSFUL:-3}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="erpbuket1_${STAMP}.dump"
TMP_PATH="${BACKUP_DIR}/.${FILENAME}.partial"
FINAL_PATH="${BACKUP_DIR}/${FILENAME}"

umask 077
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

erpbuket1_require_env_file
erpbuket1_check_docker

if ! erpbuket1_postgres_service_running; then
  echo "[backup] ERROR: postgres service is not running (project ${ERP_COMPOSE_PROJECT})" >&2
  exit 1
fi

echo "[backup] starting ${FILENAME} (project=${ERP_COMPOSE_PROJECT})"

# Dump via container env (POSTGRES_* inside container — not printed here).
if ! erpbuket1_compose exec -T "${SERVICE}" \
  sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "${TMP_PATH}"; then
  rm -f "${TMP_PATH}"
  echo "[backup] FAILED: pg_dump exited non-zero" >&2
  exit 1
fi

if [[ ! -s "${TMP_PATH}" ]]; then
  rm -f "${TMP_PATH}"
  echo "[backup] FAILED: empty dump" >&2
  exit 1
fi

# Custom-format dump magic: "PGDMP" at start
magic="$(head -c 5 "${TMP_PATH}" 2>/dev/null || true)"
if [[ "${magic}" != "PGDMP" ]]; then
  rm -f "${TMP_PATH}"
  echo "[backup] FAILED: dump does not look like pg_dump -Fc (bad magic)" >&2
  exit 1
fi

mv "${TMP_PATH}" "${FINAL_PATH}"
chmod 600 "${FINAL_PATH}"

SIZE="$(wc -c < "${FINAL_PATH}" | tr -d ' ')"
echo "[backup] wrote ${FINAL_PATH} (${SIZE} bytes)"

# Optional retention prune — never runs unless both flags set.
if [[ "${PRUNE_BACKUPS:-0}" == "1" ]]; then
  if [[ "${CONFIRM_BACKUP_PRUNE:-}" != "YES" ]]; then
    echo "[backup] PRUNE_BACKUPS=1 ignored without CONFIRM_BACKUP_PRUNE=YES" >&2
  else
    mapfile -t dumps < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'erpbuket1_*.dump' | sort || true)
    total="${#dumps[@]}"
    if (( total < MIN_KEEP_SUCCESSFUL )); then
      echo "[backup] prune skipped: only ${total} dump(s), need >= ${MIN_KEEP_SUCCESSFUL}" >&2
    else
      echo "[backup] pruning dumps older than ${RETENTION_DAYS} days (keeping at least ${MIN_KEEP_SUCCESSFUL})"
      # Delete old files but never go below MIN_KEEP_SUCCESSFUL newest
      mapfile -t old < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'erpbuket1_*.dump' -mtime "+${RETENTION_DAYS}" | sort || true)
      for f in "${old[@]}"; do
        remaining="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'erpbuket1_*.dump' | wc -l | tr -d ' ')"
        if (( remaining <= MIN_KEEP_SUCCESSFUL )); then
          echo "[backup] prune stop: would drop below ${MIN_KEEP_SUCCESSFUL} dumps"
          break
        fi
        echo "[backup] prune remove: ${f}"
        rm -f "${f}"
      done
    fi
  fi
else
  echo "[backup] retention policy documented (default ${RETENTION_DAYS}d); auto-prune OFF (set PRUNE_BACKUPS=1 CONFIRM_BACKUP_PRUNE=YES)"
fi

echo "[backup] done. Copy dumps OFF this VPS (separate host or encrypted store). Do not use shop S3 without agreement."
exit 0
