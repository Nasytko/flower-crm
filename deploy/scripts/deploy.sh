#!/usr/bin/env bash
# erpbuket1 production deploy (update or controlled first bring-up).
#
# Operates on the CURRENT git working tree only -- does not git pull / reset.
#
# Usage (from /opt/erpbuket1):
#   ./deploy/scripts/deploy.sh
#
# Optional:
#   ERP_ENV_FILE=/etc/erpbuket1/production.env
#   ALLOW_DIRTY=1
#   SKIP_BUILD=1
#   HEALTH_RETRIES=45 HEALTH_SLEEP=2
#   ALLOW_NONSTANDARD_APP_DIR=1
#
# Emergency only (existing DB):
#   SKIP_BACKUP=1 CONFIRM_SKIP_BACKUP=YES I_UNDERSTAND_DATA_LOSS_RISK=YES
#
# Does NOT: git reset --hard, down -v, volume/system prune, seed/bootstrap,
#           touch shopbuket1, modify Nginx.
# Zero-downtime is NOT promised. Automatic app/DB rollback is NOT implemented.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

HEALTH_RETRIES="${HEALTH_RETRIES:-45}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"

log() { erpbuket1_log "deploy: $*"; }
die() { erpbuket1_die "deploy: $*"; }

check_git_tree() {
  command -v git >/dev/null || die "git not found"
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "not a git repository"
  fi
  local dirty
  dirty="$(git status --porcelain 2>/dev/null || true)"
  if [[ -n "${dirty}" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
    die "working tree is dirty; commit/stash changes or set ALLOW_DIRTY=1"
  fi
  if [[ -n "${dirty}" ]]; then
    erpbuket1_warn "deploy: dirty working tree allowed (ALLOW_DIRTY=1)"
  fi
  GIT_SHA="$(git rev-parse HEAD)"
  GIT_SHORT="$(git rev-parse --short HEAD)"
  GIT_DESC="$(git log -1 --pretty=format:'%h %s' 2>/dev/null || echo "${GIT_SHORT}")"
  log "release: ${GIT_DESC}"
}

require_backup_or_emergency_skip() {
  local state="$1"
  if [[ "${state}" != "existing" ]]; then
    log "DB state=${state} -- no pre-migration backup required"
    return 0
  fi

  if [[ "${SKIP_BACKUP:-0}" == "1" ]]; then
    if [[ "${CONFIRM_SKIP_BACKUP:-}" != "YES" || "${I_UNDERSTAND_DATA_LOSS_RISK:-}" != "YES" ]]; then
      die "SKIP_BACKUP=1 on existing DB requires CONFIRM_SKIP_BACKUP=YES and I_UNDERSTAND_DATA_LOSS_RISK=YES"
    fi
    erpbuket1_warn "deploy: EMERGENCY skip backup on EXISTING database (operator confirmed)"
    return 0
  fi

  log "existing DB -- ensuring postgres is up before backup"
  erpbuket1_ensure_postgres_ready "${HEALTH_RETRIES}" "${HEALTH_SLEEP}"

  log "backup before migrate"
  BACKUP_DIR="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}" \
    "${SCRIPT_DIR}/backup-postgres.sh" || die "backup failed -- deploy aborted (migrate not run)"
}

main() {
  local db_state db_state_for_backup
  DEPLOY_OK=0

  erpbuket1_setup_tmp_trap
  erpbuket1_acquire_lock
  erpbuket1_require_app_dir

  local root
  root="$(erpbuket1_root_dir)"
  cd "${root}"

  log "preflight"
  erpbuket1_check_commands git curl openssl
  erpbuket1_check_docker
  erpbuket1_check_resources
  check_git_tree
  erpbuket1_validate_env
  erpbuket1_load_ports
  erpbuket1_check_ports_available
  erpbuket1_check_shop_coexistence

  db_state="$(erpbuket1_require_safe_db_state_for_deploy)"

  if [[ "${db_state}" == "fresh" ]]; then
    log "fresh: new postgres volume will be created on first postgres start"
  fi
  if [[ "${db_state}" == "existing" || "${db_state}" == "volume_unproven" ]]; then
    # After successful provenance gate, ensure marker exists for future runs
    :
  fi
  # Backup required for existing OR operator-accepted unproven volume (treated as data-bearing)
  if [[ "${db_state}" == "volume_unproven" ]]; then
    db_state_for_backup="existing"
  else
    db_state_for_backup="${db_state}"
  fi

  log "compose config validation"
  erpbuket1_compose config >/dev/null || die "compose config invalid"

  # Backup BEFORE build/migrate for data-bearing DBs (even if postgres was stopped).
  require_backup_or_emergency_skip "${db_state_for_backup}"

  if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    log "SKIP_BUILD=1 -- not rebuilding images"
  else
    log "building images"
    erpbuket1_compose build || die "image build failed -- API/Web not switched"
  fi

  # Always ensure postgres before migrate (fresh or existing).
  erpbuket1_ensure_postgres_ready "${HEALTH_RETRIES}" "${HEALTH_SLEEP}"

  log "prisma migrate deploy"
  if ! erpbuket1_compose run --rm migrate; then
    die "migration failed -- API/Web NOT updated; no automatic DB rollback"
  fi

  log "updating api + web (compose up -d; no down -v)"
  erpbuket1_compose up -d api web || die "failed to start api/web"

  log "healthcheck (internal)"
  if ! HEALTH_RETRIES="${HEALTH_RETRIES}" HEALTH_SLEEP="${HEALTH_SLEEP}" \
    "${SCRIPT_DIR}/healthcheck.sh" --mode=internal; then
    die "healthcheck failed after deploy -- do NOT assume success; inspect logs"
  fi

  erpbuket1_write_install_marker
  DEPLOY_OK=1

  echo
  log "======== DEPLOY REPORT ========"
  log "status: SUCCESS"
  log "git: ${GIT_DESC}"
  log "sha: ${GIT_SHA}"
  log "db_state: ${db_state}"
  log "env: ${ERP_ENV_FILE}"
  log "project: ${ERP_COMPOSE_PROJECT}"
  log "web loopback: http://127.0.0.1:${ERP_WEB_PORT}/login"
  log "api loopback: http://127.0.0.1:${ERP_API_PORT}/api/v1/health"
  erpbuket1_compose ps
  log "NOTE: public HTTPS requires ./deploy/scripts/install-nginx.sh (+ issue-cert.sh)"
  log "NOTE: bootstrap users is manual (bootstrap-initial-users.sh)"
  log "NOTE: automatic rollback is NOT implemented"
  log "==============================="
}

main "$@"
