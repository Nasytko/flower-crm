#!/usr/bin/env bash
# Full ERP backup entrypoint: PostgreSQL dump + uploads volume archive.
# See backup-postgres.sh / backup-uploads.sh for options.
#
# Does NOT touch shopbuket1. Does NOT print secrets.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[backup] postgres dump"
"${SCRIPT_DIR}/backup-postgres.sh"

echo "[backup] uploads volume"
"${SCRIPT_DIR}/backup-uploads.sh"

echo "[backup] complete (ERP only)"
exit 0
