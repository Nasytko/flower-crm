#!/usr/bin/env bash
# Convenience entrypoint for erpbuket1 PostgreSQL backup.
# See backup-postgres.sh for options (PRUNE_BACKUPS, RETENTION_DAYS, etc.).
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/backup-postgres.sh" "$@"
