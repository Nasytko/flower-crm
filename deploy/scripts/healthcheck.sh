#!/usr/bin/env bash
# erpbuket1 health checks.
#
# Usage:
#   ./deploy/scripts/healthcheck.sh --mode=internal
#   ./deploy/scripts/healthcheck.sh --mode=public
#
# internal: loopback (no Nginx required)
# public: HTTPS + redirect + TLS (after install-nginx --mode=https)

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/erpbuket1-env.sh
source "${SCRIPT_DIR}/lib/erpbuket1-env.sh"

MODE="internal"
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"
CURL_MAX="${CURL_MAX:-8}"

usage() {
  echo "Usage: $0 [--mode=internal|public]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode=internal|--mode=public) MODE="${1#--mode=}"; shift ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; erpbuket1_die "unknown argument: $1" ;;
  esac
done

[[ "${MODE}" == "internal" || "${MODE}" == "public" ]] || erpbuket1_die "invalid mode: ${MODE}"

failures=0
note() { erpbuket1_log "health[${MODE}]: $*"; }
fail() { erpbuket1_warn "health[${MODE}]: $*"; failures=$((failures + 1)); }

wait_http_ok() {
  local url="$1"
  local i
  for i in $(seq 1 "${HEALTH_RETRIES}"); do
    if curl -fsS -m "${CURL_MAX}" "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${HEALTH_SLEEP}"
  done
  return 1
}

wait_http_code() {
  local url="$1"
  local i code="000"
  for i in $(seq 1 "${HEALTH_RETRIES}"); do
    code="$(curl -sS -m "${CURL_MAX}" -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null || echo 000)"
    if [[ "${code}" =~ ^(200|301|302|307|308)$ ]]; then
      printf '%s' "${code}"
      return 0
    fi
    sleep "${HEALTH_SLEEP}"
  done
  printf '%s' "${code}"
  return 1
}

erpbuket1_require_app_dir
erpbuket1_require_env_file
erpbuket1_load_ports
erpbuket1_load_public_identity
erpbuket1_check_commands curl docker
erpbuket1_check_docker

note "compose project ${ERP_COMPOSE_PROJECT}"
if ! erpbuket1_compose ps >/dev/null 2>&1; then
  fail "cannot query compose project"
else
  erpbuket1_compose ps
fi

if erpbuket1_postgres_service_running; then
  if erpbuket1_compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    note "postgres ready"
  else
    fail "postgres running but pg_isready failed"
  fi
else
  fail "postgres service not running"
fi

if [[ "${MODE}" == "internal" ]]; then
  api_url="http://127.0.0.1:${ERP_API_PORT}/api/v1/health"
  web_url="http://127.0.0.1:${ERP_WEB_PORT}/login"
  if wait_http_ok "${api_url}"; then
    note "API OK ${api_url}"
  else
    fail "API health failed: ${api_url}"
  fi
  code="$(wait_http_code "${web_url}" || true)"
  if [[ "${code}" =~ ^(200|301|302|307|308)$ ]]; then
    note "WEB OK ${web_url} (HTTP ${code})"
  else
    fail "WEB failed: ${web_url} (HTTP ${code:-000})"
  fi
else
  # public mode
  if [[ -z "${WEB_URL:-}" || -z "${ERP_DOMAIN:-}" ]]; then
    fail "WEB_URL/ERP_DOMAIN empty"
  elif [[ "${WEB_URL}" != https://* ]]; then
    fail "public mode expects WEB_URL to be https://... (got non-https)"
  else
    base="${WEB_URL%/}"
    # Domain alignment
    if [[ "${base}" != "https://${ERP_DOMAIN}" ]]; then
      fail "WEB_URL (${base}) does not match https://${ERP_DOMAIN}"
    fi

    # HTTP -> HTTPS redirect
    http_code="$(curl -sS -m "${CURL_MAX}" -o /dev/null -w '%{http_code}' "http://${ERP_DOMAIN}/login" 2>/dev/null || echo 000)"
    http_loc="$(curl -sS -m "${CURL_MAX}" -o /dev/null -w '%{redirect_url}' "http://${ERP_DOMAIN}/login" 2>/dev/null || true)"
    if [[ "${http_code}" =~ ^(301|302|307|308)$ && "${http_loc}" == https://* ]]; then
      note "HTTP->HTTPS redirect OK (${http_code} -> https)"
    else
      fail "HTTP->HTTPS redirect missing/unexpected (code=${http_code})"
    fi

    # TLS certificate present (curl verify)
    if curl -fsS -m "${CURL_MAX}" --proto '=https' --tlsv1.2 "${base}/api/v1/health" >/dev/null 2>&1; then
      note "TLS + public API OK ${base}/api/v1/health"
    else
      fail "public HTTPS API failed (DNS/Nginx/cert?)"
    fi

    code="$(wait_http_code "${base}/login" || true)"
    if [[ "${code}" =~ ^(200|301|302|307|308)$ ]]; then
      note "public WEB OK ${base}/login (HTTP ${code})"
    else
      fail "public WEB failed ${base}/login (HTTP ${code:-000})"
    fi

    # TLS subject + expiry (fail if expired / not yet valid)
    if erpbuket1_need_cmd openssl; then
      tls_pem="$(echo | openssl s_client -servername "${ERP_DOMAIN}" -connect "${ERP_DOMAIN}:443" 2>/dev/null | openssl x509 2>/dev/null || true)"
      if [[ -z "${tls_pem}" ]]; then
        fail "could not fetch TLS certificate for ${ERP_DOMAIN}:443"
      else
        if printf '%s\n' "${tls_pem}" | openssl x509 -noout -subject 2>/dev/null | grep -qi "${ERP_DOMAIN}"; then
          note "TLS certificate subject mentions ${ERP_DOMAIN}"
        else
          erpbuket1_warn "health[public]: cert subject may not contain domain (check SAN)"
        fi
        if printf '%s\n' "${tls_pem}" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
          enddate="$(printf '%s\n' "${tls_pem}" | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
          note "TLS certificate not expired (notAfter=${enddate:-unknown})"
        else
          fail "TLS certificate is expired or not yet valid"
        fi
      fi
    fi
  fi
fi

unhealthy="$(docker ps --filter "label=com.docker.compose.project=${ERP_COMPOSE_PROJECT}" --filter "health=unhealthy" --format '{{.Names}}' 2>/dev/null || true)"
if [[ -n "${unhealthy}" ]]; then
  fail "unhealthy containers: ${unhealthy}"
fi

restarting="$(docker ps --filter "label=com.docker.compose.project=${ERP_COMPOSE_PROJECT}" --filter "status=restarting" --format '{{.Names}}' 2>/dev/null || true)"
if [[ -n "${restarting}" ]]; then
  fail "restarting containers: ${restarting}"
fi

if [[ "${failures}" -gt 0 ]]; then
  erpbuket1_warn "healthcheck FAILED (${failures} issue(s))"
  exit 1
fi

note "SUCCESS"
exit 0
