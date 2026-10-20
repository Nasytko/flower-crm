#!/usr/bin/env bash
# Backup erpbuket1 product uploads volume (erpbuket1_uploads_data only).
#
# Usage:
#   ./deploy/scripts/backup-uploads.sh
#
# Writes: /var/backups/erpbuket1/erpbuket1_uploads_YYYYMMDDTHHMMSSZ.tgz
# Does NOT touch shopbuket1 volumes.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

BACKUP_DIR="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-erpbuket1_uploads_data}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="erpbuket1_uploads_${STAMP}.tgz"
TMP_PATH="${BACKUP_DIR}/.${FILENAME}.partial"
FINAL_PATH="${BACKUP_DIR}/${FILENAME}"

umask 077
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

erpbuket1_check_docker

if ! docker volume inspect "${UPLOADS_VOLUME}" >/dev/null 2>&1; then
  echo "[backup-uploads] volume ${UPLOADS_VOLUME} not found — skipping (fresh install or unused uploads)" >&2
  exit 0
fi

echo "[backup-uploads] archiving ${UPLOADS_VOLUME} -> ${FILENAME}"

# Use a throwaway alpine container; bind only the ERP uploads volume + backup dir.
if ! docker run --rm \
  --name "erpbuket1-backup-uploads-$$" \
  -v "${UPLOADS_VOLUME}:/data:ro" \
  -v "${BACKUP_DIR}:/out" \
  alpine:3.20 \
  sh -c "tar czf \"/out/.${FILENAME}.partial\" -C /data . && mv \"/out/.${FILENAME}.partial\" \"/out/${FILENAME}\""; then
  rm -f "${TMP_PATH}"
  echo "[backup-uploads] FAILED: tar archive" >&2
  exit 1
fi

if [[ ! -s "${FINAL_PATH}" ]]; then
  rm -f "${FINAL_PATH}" "${TMP_PATH}"
  echo "[backup-uploads] FAILED: empty archive" >&2
  exit 1
fi

chmod 600 "${FINAL_PATH}"
SIZE="$(wc -c < "${FINAL_PATH}" | tr -d ' ')"
# gzip magic check (1f 8b) — portable via od/hexdump if available
if command -v od >/dev/null 2>&1; then
  magic="$(od -An -tx1 -N2 "${FINAL_PATH}" | tr -d ' \n')"
  if [[ "${magic}" != "1f8b" ]]; then
    rm -f "${FINAL_PATH}"
    echo "[backup-uploads] FAILED: archive does not look like gzip" >&2
    exit 1
  fi
fi

echo "[backup-uploads] wrote ${FINAL_PATH} (${SIZE} bytes)"
exit 0
