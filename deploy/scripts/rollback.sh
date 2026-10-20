#!/usr/bin/env bash
# Safe application rollback for erpbuket1 (images from an older git revision).
#
# Builds the old revision in a temporary git worktree — the primary checkout
# (/opt/erpbuket1) is NOT switched to detached HEAD.
#
# Does NOT:
#   - roll back PostgreSQL / Prisma schema
#   - git reset --hard
#   - delete volumes
#   - touch shopbuket1 or host Nginx
#   - treat HTTP healthcheck alone as schema compatibility proof
#
# Usage (from /opt/erpbuket1):
#   CONFIRM_ROLLBACK=YES ROLLBACK_TO=<git-sha-or-tag> ./deploy/scripts/rollback.sh
#
# If the live DB has Prisma migrations not present in ROLLBACK_TO, rollback
# refuses unless:
#   CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA=YES
# (documented manual acceptance — schema is still NOT downgraded).
#
# After success: primary tree unchanged; running containers use images built
# from ROLLBACK_TO. Next normal update:
#   git pull   # on primary tree
#   ./deploy/scripts/deploy.sh
#
# Prefer forward-fix releases over rolling back past applied migrations.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

WORKTREE=""
ORIG_HEAD=""
ORIG_BRANCH=""

log() { erpbuket1_log "rollback: $*"; }
die() { erpbuket1_die "rollback: $*"; }

cleanup_worktree() {
  if [[ -n "${WORKTREE}" && -d "${WORKTREE}" ]]; then
    local root
    root="$(erpbuket1_root_dir)"
    git -C "${root}" worktree remove --force "${WORKTREE}" >/dev/null 2>&1 \
      || rm -rf "${WORKTREE}" || true
  fi
}

list_target_migrations() {
  local sha="$1"
  git ls-tree --name-only "${sha}:packages/database/prisma/migrations" 2>/dev/null \
    | awk -F/ '{print $NF}' | grep -E . | sort -u || true
}

list_db_migrations() {
  # Applied migration names from live ERP postgres (no secrets printed)
  erpbuket1_compose exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name"' \
    2>/dev/null | tr -d '\r' | grep -E . | sort -u || true
}

assert_schema_compatible_or_confirm() {
  local target_sha="$1"
  local db_m tgt_m extra
  mapfile -t db_m < <(list_db_migrations)
  mapfile -t tgt_m < <(list_target_migrations "${target_sha}")

  if ((${#db_m[@]} == 0)); then
    erpbuket1_warn "rollback: could not read _prisma_migrations (empty or query failed)"
    if [[ "${CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA:-}" == "YES" ]]; then
      erpbuket1_warn "CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA=YES — proceeding without DB migration proof"
      return 0
    fi
    die "fail closed: cannot prove Prisma compatibility. Fix DB access or set CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA=YES after manual review (see docs)."
  fi

  if ((${#tgt_m[@]} == 0)); then
    die "target revision has no packages/database/prisma/migrations — refusing"
  fi

  extra=()
  local m
  for m in "${db_m[@]}"; do
    if ! printf '%s\n' "${tgt_m[@]}" | grep -qx "${m}"; then
      extra+=("${m}")
    fi
  done

  if ((${#extra[@]} > 0)); then
    erpbuket1_warn "DB has migrations not in ROLLBACK_TO (schema newer than app):"
    printf '  - %s\n' "${extra[@]}" >&2
    if [[ "${CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA:-}" == "YES" ]]; then
      erpbuket1_warn "CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA=YES — app rollback allowed; schema NOT downgraded"
      return 0
    fi
    die "fail closed: DB schema is ahead of ROLLBACK_TO. Prefer a forward-fix release, or restore a matching dump. To force app-only rollback after manual review: CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA=YES"
  fi

  log "Prisma check: all applied DB migrations are present in ROLLBACK_TO (no schema downgrade needed)"
}

main() {
  if [[ "${CONFIRM_ROLLBACK:-}" != "YES" ]]; then
    die "refusing: set CONFIRM_ROLLBACK=YES ROLLBACK_TO=<sha-or-tag>"
  fi
  [[ -n "${ROLLBACK_TO:-}" ]] || die "set ROLLBACK_TO to a git commit SHA or tag"

  erpbuket1_setup_tmp_trap
  # shellcheck disable=SC2064
  trap 'cleanup_worktree; rm -rf "${ERP_TMP_DIR:-}"; exit 130' INT
  # shellcheck disable=SC2064
  trap 'cleanup_worktree; rm -rf "${ERP_TMP_DIR:-}"; exit 143' TERM
  # shellcheck disable=SC2064
  trap 'cleanup_worktree; rm -rf "${ERP_TMP_DIR:-}"' EXIT

  erpbuket1_acquire_lock
  erpbuket1_require_app_dir

  local root
  root="$(erpbuket1_root_dir)"
  cd "${root}"

  erpbuket1_check_commands git curl openssl
  erpbuket1_check_docker
  erpbuket1_validate_env
  erpbuket1_load_ports
  erpbuket1_check_ports_available
  erpbuket1_check_shop_coexistence

  local db_state
  db_state="$(erpbuket1_require_safe_db_state_for_deploy)"

  if ! git rev-parse --verify "${ROLLBACK_TO}^{commit}" >/dev/null 2>&1; then
    die "ROLLBACK_TO='${ROLLBACK_TO}' is not a resolvable git commit/tag in this clone"
  fi

  local target_sha
  target_sha="$(git rev-parse "${ROLLBACK_TO}^{commit}")"
  ORIG_HEAD="$(git rev-parse HEAD)"
  ORIG_BRANCH="$(git branch --show-current 2>/dev/null || true)"
  log "primary HEAD: ${ORIG_HEAD} branch=${ORIG_BRANCH:-DETACHED}"
  log "rollback target: ${target_sha} (${ROLLBACK_TO})"

  if [[ "${target_sha}" == "${ORIG_HEAD}" ]]; then
    die "primary tree already at ${target_sha}; nothing to roll back"
  fi

  local dirty
  dirty="$(git status --porcelain 2>/dev/null || true)"
  if [[ -n "${dirty}" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
    die "primary working tree dirty; commit/stash or set ALLOW_DIRTY=1 (no git reset --hard; worktree keeps primary untouched)"
  fi

  if [[ "${db_state}" == "existing" || "${db_state}" == "volume_unproven" ]]; then
    if [[ "${SKIP_BACKUP:-0}" == "1" ]]; then
      if [[ "${CONFIRM_SKIP_BACKUP:-}" != "YES" || "${I_UNDERSTAND_DATA_LOSS_RISK:-}" != "YES" ]]; then
        die "SKIP_BACKUP requires CONFIRM_SKIP_BACKUP=YES and I_UNDERSTAND_DATA_LOSS_RISK=YES"
      fi
      erpbuket1_warn "emergency skip backup before rollback"
    else
      log "backup before rollback"
      erpbuket1_ensure_postgres_ready 45 2
      BACKUP_DIR="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}" \
        "${SCRIPT_DIR}/backup-postgres.sh" || die "backup failed — rollback aborted"
    fi
    erpbuket1_ensure_postgres_ready 45 2
    assert_schema_compatible_or_confirm "${target_sha}"
  else
    erpbuket1_warn "rollback without existing DB volume — schema check skipped"
  fi

  WORKTREE="${ERP_TMP_DIR}/rollback-worktree"
  log "adding git worktree at ${WORKTREE} (primary tree stays on ${ORIG_BRANCH:-${ORIG_HEAD}})"
  git worktree add --detach "${WORKTREE}" "${target_sha}" || die "git worktree add failed"

  export COMPOSE_FILE="${WORKTREE}/docker-compose.prod.yml"
  [[ -f "${COMPOSE_FILE}" ]] || die "compose file missing in worktree: ${COMPOSE_FILE}"

  erpbuket1_compose config >/dev/null || die "compose config invalid at rolled-back revision"

  if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    log "SKIP_BUILD=1"
  else
    log "building images from worktree revision ${target_sha}"
    erpbuket1_compose build || die "image build failed — primary tree and running containers unchanged"
  fi

  erpbuket1_ensure_postgres_ready 45 2

  log "starting api+web from rolled-back images (NO prisma migrate)"
  erpbuket1_compose up -d api web || die "failed to start api/web — inspect; primary git tree unchanged"

  if ! HEALTH_RETRIES="${HEALTH_RETRIES:-30}" HEALTH_SLEEP="${HEALTH_SLEEP:-2}" \
    "${SCRIPT_DIR}/healthcheck.sh" --mode=internal; then
    die "healthcheck failed after image rollback — primary git tree unchanged; DB backup (if any) in ${ERP_BACKUP_DIR_DEFAULT}"
  fi

  cleanup_worktree
  WORKTREE=""
  unset COMPOSE_FILE

  echo
  log "======== ROLLBACK REPORT ========"
  log "status: APP IMAGE ROLLBACK COMPLETE"
  log "schema: NOT modified (no migrate / no downgrade)"
  log "primary git HEAD unchanged: $(git rev-parse HEAD) branch=${ORIG_BRANCH:-DETACHED}"
  log "images built from: ${target_sha}"
  log "healthcheck: internal HTTP OK (NOT sole proof of schema compatibility — Prisma check ran above)"
  log "next update: git pull && ./deploy/scripts/deploy.sh  (forward path)"
  log "if app misbehaves: restore dump from ${ERP_BACKUP_DIR_DEFAULT} or deploy a forward-fix commit"
  log "Nginx/Certbot unchanged"
  log "================================="
}

main "$@"
