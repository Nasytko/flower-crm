#!/usr/bin/env bash
# Conservative NewERP production deploy helper (manual VPS use).
#
# FIRST DEPLOY (empty volume):
#   FIRST_DEPLOY=1 ./deploy/scripts/deploy.sh
#
# NORMAL UPDATE:
#   ./deploy/scripts/deploy.sh
#
# Does NOT: git reset --hard, seed production, prune volumes, or hide failures.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE=(docker compose -f docker-compose.prod.yml)
FIRST_DEPLOY="${FIRST_DEPLOY:-0}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

[[ -f .env ]] || die "missing .env in ${ROOT_DIR}"
command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null || die "docker compose plugin not found"

log "preflight compose config"
"${COMPOSE[@]}" config >/dev/null

if [[ "${FIRST_DEPLOY}" != "1" && "${SKIP_BACKUP}" != "1" ]]; then
  if docker ps --format '{{.Names}}' | grep -qx 'newerp-postgres'; then
    log "backup before update"
    ./deploy/scripts/backup-postgres.sh
  else
    log "postgres container not running — skipping backup"
  fi
else
  log "skipping backup (FIRST_DEPLOY or SKIP_BACKUP)"
fi

log "git revision: $(git rev-parse --short HEAD 2>/dev/null || echo 'n/a')"

log "build images"
"${COMPOSE[@]}" build

log "start postgres"
"${COMPOSE[@]}" up -d postgres

log "wait for postgres healthy"
for _ in $(seq 1 "${HEALTH_RETRIES}"); do
  status="$("${COMPOSE[@]}" ps --format json postgres 2>/dev/null | head -n1 || true)"
  if "${COMPOSE[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    break
  fi
  sleep "${HEALTH_SLEEP}"
done
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  || die "postgres not ready"

log "prisma migrate deploy"
if ! "${COMPOSE[@]}" run --rm migrate; then
  die "migration failed — application NOT updated; investigate before retry"
fi

log "start api + web"
"${COMPOSE[@]}" up -d api web

log "wait for API readiness"
ok=0
for _ in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl -fsS "http://127.0.0.1:3001/api/v1/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep "${HEALTH_SLEEP}"
done
[[ "${ok}" == "1" ]] || die "API health check failed"

log "wait for WEB"
ok=0
for _ in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl -fsS "http://127.0.0.1:3000/login" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep "${HEALTH_SLEEP}"
done
[[ "${ok}" == "1" ]] || die "WEB health check failed"

log "compose ps"
"${COMPOSE[@]}" ps

log "SUCCESS"
log "smoke: curl -fsS http://127.0.0.1:3001/api/v1/health"
log "public: https://erp.nasytko.ru (after Nginx + Certbot)"
if [[ "${FIRST_DEPLOY}" == "1" ]]; then
  log "FIRST DEPLOY: create initial users via documented bootstrap (seed is NOT auto-run)"
fi
