#!/usr/bin/env bash
# Install / update ONLY the erpbuket1 Nginx vhost on the host.
#
# Does NOT modify shopbuket1 (or any other) site files.
# Does NOT run certbot (see issue-cert.sh).
#
# Usage (from /opt/erpbuket1):
#   CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh
#   CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh --mode=http
#   CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh --mode=https
#
# --mode=http   : HTTP vhost + ACME webroot (default, before certificate)
# --mode=https  : HTTP->HTTPS redirect + TLS (requires existing Let's Encrypt cert)

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

MODE="http"
ROOT="$(erpbuket1_root_dir)"
TEMPLATE_HTTP="${ROOT}/deploy/nginx/erpbuket1.conf.template"
TEMPLATE_SSL="${ROOT}/deploy/nginx/erpbuket1.ssl.conf.template"
BACKUP=""
NGINX_WRITE_STARTED=0

log() { erpbuket1_log "nginx: $*"; }
die() { erpbuket1_die "nginx: $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode=http|--mode=https) MODE="${1#--mode=}"; shift ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: CONFIRM_NGINX_INSTALL=YES $0 [--mode=http|https]"
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "${MODE}" == "http" || "${MODE}" == "https" ]] || die "invalid mode"

rollback_nginx_write() {
  if [[ "${NGINX_WRITE_STARTED}" != "1" ]]; then
    return 0
  fi
  erpbuket1_warn "nginx: rolling back ERP vhost after interrupt/failure"
  if [[ -n "${BACKUP}" && -f "${BACKUP}" ]]; then
    cp -a "${BACKUP}" "${ERP_NGINX_AVAILABLE}" || true
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  else
    rm -f "${ERP_NGINX_ENABLED}" "${ERP_NGINX_AVAILABLE}" || true
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
}

restore_backup() {
  if [[ -n "${BACKUP}" && -f "${BACKUP}" ]]; then
    log "restoring previous ERP nginx config from ${BACKUP}"
    cp -a "${BACKUP}" "${ERP_NGINX_AVAILABLE}" || true
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
}

# Safe placeholder substitution (no sed with untrusted domain).
render_template() {
  local src="$1" dest="$2"
  local domain web api acme cert key line
  domain="$(erpbuket1_env_get ERP_DOMAIN)"
  erpbuket1_load_ports
  web="${ERP_WEB_PORT}"
  api="${ERP_API_PORT}"
  acme="${ERP_ACME_WEBROOT}"
  cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
  key="/etc/letsencrypt/live/${domain}/privkey.pem"

  erpbuket1_validate_hostname "${domain}" || die "ERP_DOMAIN is not a valid DNS hostname"
  [[ -f "${src}" ]] || die "template missing: ${src}"
  [[ "${web}" =~ ^[0-9]+$ && "${api}" =~ ^[0-9]+$ ]] || die "ports must be numeric"

  : >"${dest}"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line//__ERP_DOMAIN__/${domain}}"
    line="${line//__ERP_WEB_PORT__/${web}}"
    line="${line//__ERP_API_PORT__/${api}}"
    line="${line//__ERP_ACME_WEBROOT__/${acme}}"
    line="${line//__SSL_CERTIFICATE__/${cert}}"
    line="${line//__SSL_CERTIFICATE_KEY__/${key}}"
    printf '%s\n' "${line}" >>"${dest}"
  done <"${src}"

  if grep -E '__ERP_|__SSL_' "${dest}" >/dev/null 2>&1; then
    die "render left unsubstituted placeholders in ${dest}"
  fi
  grep -F "server_name ${domain};" "${dest}" >/dev/null || die "render missing server_name ${domain}"
  grep -F "127.0.0.1:${web}" "${dest}" >/dev/null || die "render missing web upstream port"
  grep -F "127.0.0.1:${api}" "${dest}" >/dev/null || die "render missing api upstream port"
}

assert_no_foreign_server_name_collision() {
  local domain="$1"
  local f real token
  local escaped
  escaped="$(erpbuket1_escape_grep_fixed "${domain}")"
  for f in /etc/nginx/sites-enabled/*; do
    [[ -e "${f}" ]] || continue
    real="$(readlink -f "${f}" 2>/dev/null || echo "${f}")"
    if [[ "${real}" == "$(readlink -f "${ERP_NGINX_AVAILABLE}" 2>/dev/null || echo "${ERP_NGINX_AVAILABLE}")" ]]; then
      continue
    fi
    if [[ "${f}" == "${ERP_NGINX_ENABLED}" ]]; then
      continue
    fi
    # Tokenize server_name lines; require exact hostname token match
    while IFS= read -r token; do
      [[ -n "${token}" ]] || continue
      if [[ "${token}" == "${domain}" ]]; then
        die "domain ${domain} already appears in ${f} -- refusing duplicate server_name"
      fi
    done < <(grep -E "^[[:space:]]*server_name[[:space:]]+" "${f}" 2>/dev/null \
      | sed -e 's/#.*//' -e 's/server_name//' -e 's/;//g' \
      | tr ' ' '\n' | grep -E . || true)
    # Also catch compacted forms via escaped literal regex
    if grep -E "server_name[[:space:]].*[[:space:]]${escaped}([[:space:;]]|$)" "${f}" >/dev/null 2>&1; then
      # verify with fixed-string as well
      if grep -F "${domain}" "${f}" >/dev/null 2>&1; then
        die "domain ${domain} already appears in ${f} -- refusing duplicate server_name"
      fi
    fi
  done
}

main() {
  if [[ "${CONFIRM_NGINX_INSTALL:-}" != "YES" ]]; then
    die "refusing: set CONFIRM_NGINX_INSTALL=YES (explicit; will not run from plain install/deploy)"
  fi

  erpbuket1_setup_tmp_trap
  # Extend traps to roll back nginx write on INT/TERM
  # shellcheck disable=SC2064
  trap 'rollback_nginx_write; rm -rf "${ERP_TMP_DIR:-}"; exit 130' INT
  # shellcheck disable=SC2064
  trap 'rollback_nginx_write; rm -rf "${ERP_TMP_DIR:-}"; exit 143' TERM
  # shellcheck disable=SC2064
  trap 'rm -rf "${ERP_TMP_DIR:-}"' EXIT

  erpbuket1_acquire_lock
  erpbuket1_require_app_dir
  erpbuket1_require_env_file
  erpbuket1_validate_env
  erpbuket1_load_ports
  erpbuket1_load_public_identity

  erpbuket1_check_commands nginx
  command -v systemctl >/dev/null || die "systemctl not found"

  local domain
  domain="$(erpbuket1_env_get ERP_DOMAIN)"
  erpbuket1_validate_hostname "${domain}" || die "ERP_DOMAIN is not a valid DNS hostname"

  assert_no_foreign_server_name_collision "${domain}"

  if [[ "${MODE}" == "https" ]]; then
    local cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
    local key="/etc/letsencrypt/live/${domain}/privkey.pem"
    [[ -f "${cert}" && -f "${key}" ]] || die "TLS files missing for ${domain}; run issue-cert.sh first"
  fi

  mkdir -p "${ERP_ACME_WEBROOT}/.well-known/acme-challenge"
  chmod -R a+rX "${ERP_ACME_WEBROOT}" || true

  local rendered="${ERP_TMP_DIR}/erpbuket1.conf"
  if [[ "${MODE}" == "https" ]]; then
    render_template "${TEMPLATE_SSL}" "${rendered}"
  else
    render_template "${TEMPLATE_HTTP}" "${rendered}"
  fi

  if [[ -f "${ERP_NGINX_AVAILABLE}" ]]; then
    BACKUP="${ERP_NGINX_AVAILABLE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -a "${ERP_NGINX_AVAILABLE}" "${BACKUP}"
    log "backed up previous ERP vhost to ${BACKUP}"
  fi

  NGINX_WRITE_STARTED=1
  install -m 644 "${rendered}" "${ERP_NGINX_AVAILABLE}"
  ln -sfn "${ERP_NGINX_AVAILABLE}" "${ERP_NGINX_ENABLED}"

  log "testing full nginx config (nginx -t is global read-only check)"
  if ! nginx -t; then
    erpbuket1_warn "nginx -t failed -- rolling back ERP vhost only"
    if [[ -n "${BACKUP}" && -f "${BACKUP}" ]]; then
      restore_backup
    else
      rm -f "${ERP_NGINX_ENABLED}" "${ERP_NGINX_AVAILABLE}" || true
    fi
    NGINX_WRITE_STARTED=0
    die "nginx -t failed; shop configs were not modified by this script"
  fi

  log "reloading nginx"
  if ! systemctl reload nginx; then
    erpbuket1_warn "reload failed -- rolling back ERP vhost only"
    if [[ -n "${BACKUP}" && -f "${BACKUP}" ]]; then
      restore_backup
    else
      rm -f "${ERP_NGINX_ENABLED}" "${ERP_NGINX_AVAILABLE}" || true
    fi
    NGINX_WRITE_STARTED=0
    die "systemctl reload nginx failed"
  fi

  NGINX_WRITE_STARTED=0
  log "SUCCESS -- ERP vhost installed (${MODE})"
  log "file: ${ERP_NGINX_AVAILABLE}"
  log "enabled: ${ERP_NGINX_ENABLED}"
  log "upstream names: erpbuket1_web_upstream / erpbuket1_api_upstream (ERP-only)"
  if [[ "${MODE}" == "http" ]]; then
    log "next: CONFIRM_CERTBOT=YES ./deploy/scripts/issue-cert.sh"
    log "then: CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh --mode=https"
  else
    log "next: ./deploy/scripts/healthcheck.sh --mode=public"
  fi
}

main "$@"
