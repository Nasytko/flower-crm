#!/usr/bin/env bash
# First-time ERP install entrypoint (erpbuket1 only).
#
# Usage (after clone into /opt/erpbuket1):
#   cd /opt/erpbuket1 && ./install.sh
#
# Does NOT: install Docker/packages, change firewall, modify shopbuket1,
#           configure Nginx/Certbot (those are separate confirmed scripts).
# Refuses to overwrite an already-proven ERP install — hands off to deploy.sh.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

[[ -f "${ROOT}/deploy/scripts/install.sh" ]] || {
  echo "[erpbuket1 install] ERROR: missing deploy/scripts/install.sh" >&2
  exit 1
}

exec "${ROOT}/deploy/scripts/install.sh" "$@"
