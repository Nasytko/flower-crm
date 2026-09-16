#!/usr/bin/env bash
# Backup NewERP PostgreSQL (docker compose production).
#
# Usage:
#   ./deploy/scripts/backup-postgres.sh
#   BACKUP_DIR=/opt/backups/postgres RETENTION_DAYS=7 ./deploy/scripts/backup-postgres.sh
#
# Requires: docker, compose file at repo root, running newerp-postgres container.
#
# IMPORTANT: A backup that lives only on this VPS is NOT disaster recovery.
# Copy dumps off-box (another server, object storage, encrypted USB, etc.).

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.prod.yml}"
SERVICE="${POSTGRES_SERVICE:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="newerp_${STAMP}.dump"
TMP_PATH="${BACKUP_DIR}/.${FILENAME}.partial"
FINAL_PATH="${BACKUP_DIR}/${FILENAME}"

umask 077
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

echo "[backup] starting ${FILENAME}"

docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" \
  sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "${TMP_PATH}"

# Basic sanity: custom-format dump should not be empty
if [[ ! -s "${TMP_PATH}" ]]; then
  rm -f "${TMP_PATH}"
  echo "[backup] FAILED: empty dump" >&2
  exit 1
fi

mv "${TMP_PATH}" "${FINAL_PATH}"
chmod 600 "${FINAL_PATH}"

SIZE="$(wc -c < "${FINAL_PATH}" | tr -d ' ')"
echo "[backup] wrote ${FINAL_PATH} (${SIZE} bytes)"

# Local retention only
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'newerp_*.dump' -mtime "+${RETENTION_DAYS}" -print -delete \
  || true

echo "[backup] done (retention ${RETENTION_DAYS} days). Copy off this VPS separately."
