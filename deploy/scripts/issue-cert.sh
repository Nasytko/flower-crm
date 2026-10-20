#!/usr/bin/env bash
# Issue / renew Let's Encrypt certificate for ERP_DOMAIN only (webroot).
#
# Uses: certbot certonly --webroot
# Does NOT invoke certbot --nginx (avoids automatic edits to unrelated vhosts).
# Does NOT modify shopbuket1 configs.
#
# Prerequisites:
#   - HTTP ERP vhost installed (install-nginx.sh --mode=http) with ACME location
#   - DNS for ERP_DOMAIN points at this VPS
#
# Usage:
#   CONFIRM_CERTBOT=YES ./deploy/scripts/issue-cert.sh
#   CONFIRM_CERTBOT=YES CERTBOT_EMAIL=ops@example.com ./deploy/scripts/issue-cert.sh

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

log() { erpbuket1_log "certbot: $*"; }
die() { erpbuket1_die "certbot: $*"; }

main() {
  if [[ "${CONFIRM_CERTBOT:-}" != "YES" ]]; then
    die "refusing: set CONFIRM_CERTBOT=YES (explicit; not run from install/deploy)"
  fi

  erpbuket1_setup_tmp_trap
  erpbuket1_acquire_lock
  erpbuket1_require_app_dir
  erpbuket1_require_env_file
  erpbuket1_validate_env
  erpbuket1_load_public_identity

  erpbuket1_check_commands certbot
  erpbuket1_require_dns

  local domain email
  domain="$(erpbuket1_env_get ERP_DOMAIN)"
  email="${CERTBOT_EMAIL:-}"

  [[ -d "${ERP_ACME_WEBROOT}" ]] || die "ACME webroot missing: ${ERP_ACME_WEBROOT} (run install-nginx.sh --mode=http first)"
  [[ -f "${ERP_NGINX_AVAILABLE}" ]] || die "ERP nginx vhost missing; run install-nginx.sh --mode=http first"

  local args=(certonly --webroot -w "${ERP_ACME_WEBROOT}" -d "${domain}" --agree-tos --non-interactive --keep-until-expiring)
  if [[ -n "${email}" ]]; then
    args+=(--email "${email}")
  else
    args+=(--register-unsafely-without-email)
    erpbuket1_warn "CERTBOT_EMAIL not set -- using --register-unsafely-without-email"
  fi

  log "requesting certificate for ${domain} via webroot (ERP-only; no --nginx plugin)"
  certbot "${args[@]}" || die "certbot failed -- certificate NOT installed"

  local cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
  local key="/etc/letsencrypt/live/${domain}/privkey.pem"
  [[ -f "${cert}" && -f "${key}" ]] || die "certbot reported success but cert files missing"

  log "SUCCESS -- certificate present for ${domain}"
  log "next: CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh --mode=https"
  log "renewal: ensure 'certbot renew' timer/cron exists on host (system package); webroot renew uses same path"
  log "dry-run renew (optional): certbot renew --dry-run"
}

main "$@"
