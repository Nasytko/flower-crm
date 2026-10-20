#!/usr/bin/env bash
# Concise erpbuket1 operational status (read-only).
#
# Usage:
#   ./deploy/scripts/status.sh

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

echo "=== erpbuket1 status ==="

if [[ -f "${ERP_ENV_FILE}" ]]; then
  echo "env:      ${ERP_ENV_FILE} (present)"
  chmod_mode="$(stat -c '%a' "${ERP_ENV_FILE}" 2>/dev/null || stat -f '%OLp' "${ERP_ENV_FILE}" 2>/dev/null || echo '?')"
  echo "env mode: ${chmod_mode} (expect 600)"
  erpbuket1_load_ports
  erpbuket1_load_public_identity
  echo "domain:   ${ERP_DOMAIN:-?}"
  echo "web_url:  ${WEB_URL:-?}"
  echo "ports:    web=${ERP_WEB_PORT} api=${ERP_API_PORT} (loopback publish)"
else
  echo "env:      MISSING (${ERP_ENV_FILE})"
fi

echo "marker:   $(erpbuket1_marker_exists && echo present || echo absent) (${ERP_INSTALL_MARKER})"
echo "volume:   $(erpbuket1_volume_exists && echo present || echo MISSING) (${ERP_VOLUME_NAME})"
echo "state:    $(erpbuket1_detect_db_state 2>/dev/null || echo unknown)"

if erpbuket1_need_cmd docker && docker info >/dev/null 2>&1; then
  echo "--- compose ps ---"
  if [[ -f "${ERP_ENV_FILE}" ]]; then
    erpbuket1_compose ps 2>/dev/null || echo "(compose ps failed)"
  else
    docker ps -a --filter "label=com.docker.compose.project=${ERP_COMPOSE_PROJECT}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
  fi
else
  echo "docker:   not available"
fi

echo "--- backups ---"
BACKUP_DIR="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}"
if [[ -d "${BACKUP_DIR}" ]]; then
  echo "dir: ${BACKUP_DIR} mode=$(stat -c '%a' "${BACKUP_DIR}" 2>/dev/null || echo '?')"
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'erpbuket1_*.dump' -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' 2>/dev/null \
    | sort | tail -n 5 || ls -lt "${BACKUP_DIR}"/erpbuket1_*.dump 2>/dev/null | head -n 5 || echo "(no dumps)"
else
  echo "dir: ${BACKUP_DIR} (missing)"
fi

echo "--- nginx / tls (host) ---"
if [[ -f "${ERP_NGINX_AVAILABLE}" || -L "${ERP_NGINX_ENABLED}" ]]; then
  echo "vhost: ${ERP_NGINX_AVAILABLE} (present)"
else
  echo "vhost: not installed"
fi
if [[ -n "${ERP_DOMAIN:-}" && -f "/etc/letsencrypt/live/${ERP_DOMAIN}/fullchain.pem" ]]; then
  echo "tls:   /etc/letsencrypt/live/${ERP_DOMAIN}/fullchain.pem present"
elif [[ -n "${ERP_DOMAIN:-}" ]]; then
  echo "tls:   cert files not found for ${ERP_DOMAIN}"
fi

root="$(erpbuket1_root_dir 2>/dev/null || echo '?')"
if [[ -d "${root}/.git" ]] && erpbuket1_need_cmd git; then
  echo "--- git ---"
  echo "root: $(cd "${root}" && pwd)"
  echo "head: $(git -C "${root}" rev-parse --short HEAD 2>/dev/null || echo '?') $(git -C "${root}" log -1 --pretty=format:'%s' 2>/dev/null || true)"
  echo "branch: $(git -C "${root}" branch --show-current 2>/dev/null || echo 'DETACHED')"
fi

echo "=== end status ==="
