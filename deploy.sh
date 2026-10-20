#!/usr/bin/env bash
# One-command ERP update on the VPS (erpbuket1 only).
#
# Usage:
#   cd /opt/erpbuket1 && ./deploy.sh
#
# What this wrapper does:
#   1) Verifies we are in the ERP app tree
#   2) Fetches/pulls the agreed branch (fast-forward only; never reset --hard)
#   3) Delegates to deploy/scripts/deploy.sh (backup → build → migrate → up → health)
#
# Optional:
#   DEPLOY_BRANCH=main          # default: main
#   SKIP_GIT_PULL=1             # apply current tree only (no fetch/pull)
#   ALLOW_DIRTY=1               # allow uncommitted local changes
#   REMOTE_NAME=origin
#
# Does NOT touch shopbuket1, Nginx shop vhosts, or run docker system prune.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"
STAGE="init"

log() { echo "[erpbuket1 deploy] $*" >&2; }
die() {
  echo "[erpbuket1 deploy] ERROR at stage=${STAGE}: $*" >&2
  echo "[erpbuket1 deploy] Shop (shopbuket1) was not modified. DB volumes were not deleted." >&2
  exit 1
}

STAGE="preflight"
[[ -f "${ROOT}/docker-compose.prod.yml" ]] || die "missing docker-compose.prod.yml (wrong directory?)"
[[ -f "${ROOT}/deploy/scripts/deploy.sh" ]] || die "missing deploy/scripts/deploy.sh"
command -v git >/dev/null || die "git not found"
command -v docker >/dev/null || die "docker not found"
command -v curl >/dev/null || die "curl not found"

if [[ "${ROOT}" != "/opt/erpbuket1" && "${ALLOW_NONSTANDARD_APP_DIR:-}" != "1" ]]; then
  die "expected /opt/erpbuket1 (got ${ROOT}); set ALLOW_NONSTANDARD_APP_DIR=1 if intentional"
fi

STAGE="git-check"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"
dirty="$(git status --porcelain 2>/dev/null || true)"
if [[ -n "${dirty}" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
  die "working tree has local changes; commit/stash them or set ALLOW_DIRTY=1"
fi

if [[ "${SKIP_GIT_PULL}" != "1" ]]; then
  STAGE="git-remote"
  if ! git remote get-url "${REMOTE_NAME}" >/dev/null 2>&1; then
    die "git remote '${REMOTE_NAME}' not configured"
  fi
  # Connectivity probe without printing credentials
  if ! git ls-remote --heads "${REMOTE_NAME}" "${DEPLOY_BRANCH}" >/dev/null 2>&1; then
    die "cannot reach ${REMOTE_NAME}/${DEPLOY_BRANCH} (check network/GitHub access)"
  fi

  STAGE="git-fetch"
  log "fetching ${REMOTE_NAME}/${DEPLOY_BRANCH}"
  git fetch --prune "${REMOTE_NAME}" "${DEPLOY_BRANCH}" || die "git fetch failed"

  STAGE="git-pull"
  local_sha="$(git rev-parse HEAD)"
  remote_ref="${REMOTE_NAME}/${DEPLOY_BRANCH}"
  if ! git rev-parse --verify "${remote_ref}" >/dev/null 2>&1; then
    die "missing ref ${remote_ref} after fetch"
  fi
  remote_sha="$(git rev-parse "${remote_ref}")"
  if [[ "${local_sha}" == "${remote_sha}" ]]; then
    log "already up to date at $(git rev-parse --short HEAD)"
  else
    current_branch="$(git rev-parse --abbrev-ref HEAD)"
    if [[ "${current_branch}" != "${DEPLOY_BRANCH}" ]]; then
      die "checked out '${current_branch}', expected '${DEPLOY_BRANCH}' (or set DEPLOY_BRANCH / SKIP_GIT_PULL=1)"
    fi
    log "fast-forward ${current_branch}: $(git rev-parse --short HEAD) -> $(git rev-parse --short "${remote_ref}")"
    git merge --ff-only "${remote_ref}" || die "fast-forward failed (local commits diverge; resolve manually)"
  fi
else
  log "SKIP_GIT_PULL=1 — deploying current tree $(git rev-parse --short HEAD)"
fi

STAGE="apply"
log "running deploy/scripts/deploy.sh"
exec "${ROOT}/deploy/scripts/deploy.sh"
