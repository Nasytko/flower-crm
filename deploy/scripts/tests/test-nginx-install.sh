#!/usr/bin/env bash
# Offline tests for ERP nginx helpers / install-nginx (no real nginx/docker/certs).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIB="${ROOT}/deploy/scripts/lib/erpbuket1-env.sh"
# shellcheck source=../lib/erpbuket1-env.sh
source "${LIB}"

PASS=0
FAIL=0
note() { echo "[test] $*"; }
ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local got="$1" want="$2" msg="$3"
  if [[ "${got}" == "${want}" ]]; then ok "${msg}"; else bad "${msg} (got='${got}' want='${want}')"; fi
}

assert_true() {
  if "$@"; then ok "$*"; else bad "expected success: $*"; fi
}

assert_false() {
  if "$@"; then bad "expected failure: $*"; else ok "fail-closed: $*"; fi
}

# --- hostname validation ---
note "hostname validation"
assert_true erpbuket1_validate_hostname "wh.buketnomer1.by"
assert_true erpbuket1_validate_hostname "shop.nasytko.ru"
assert_false erpbuket1_validate_hostname "evil|rm"
assert_false erpbuket1_validate_hostname "a/b"
assert_false erpbuket1_validate_hostname ""
assert_false erpbuket1_validate_hostname "-bad.example.com"

# --- server_name token extraction / exact match ---
note "server_name token extraction"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/erpbuket1-nginx-test.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

shop_conf="${TMP}/shop.conf"
erp_conf="${TMP}/erp.conf"
confd="${TMP}/conf.d/other.conf"
mkdir -p "${TMP}/sites-enabled" "${TMP}/sites-available" "${TMP}/conf.d"

cat >"${shop_conf}" <<'EOF'
# shop vhost
server {
    listen 80;
    server_name shop.nasytko.ru;  # production shop
    location / { proxy_pass http://127.0.0.1:3000; }
}
EOF

cat >"${erp_conf}" <<'EOF'
server {
    listen 80;
    server_name wh.buketnomer1.by;
}
EOF

cat >"${confd}" <<'EOF'
server_name unused.example.com;
EOF

assert_eq "$(erpbuket1_nginx_server_name_tokens "${shop_conf}")" "shop.nasytko.ru" "shop tokens exact"

assert_true erpbuket1_nginx_file_has_server_name "shop.nasytko.ru" "${shop_conf}"
assert_false erpbuket1_nginx_file_has_server_name "wh.buketnomer1.by" "${shop_conf}"
assert_true erpbuket1_nginx_file_has_server_name "wh.buketnomer1.by" "${erp_conf}"
assert_true erpbuket1_nginx_file_has_server_name "unused.example.com" "${confd}"
# Substring must NOT match
assert_false erpbuket1_nginx_file_has_server_name "nasytko.ru" "${shop_conf}"

# Multi-token server_name line
multi="${TMP}/multi.conf"
cat >"${multi}" <<'EOF'
server_name unused.example.com wh.buketnomer1.by;
EOF
assert_true erpbuket1_nginx_file_has_server_name "wh.buketnomer1.by" "${multi}"
assert_true erpbuket1_nginx_file_has_server_name "unused.example.com" "${multi}"

# --- broken sed helper must not exist / collision path must not call sed on domain ---
note "no broken escape_grep_fixed sed path"
if declare -F erpbuket1_escape_grep_fixed >/dev/null 2>&1; then
  bad "erpbuket1_escape_grep_fixed still defined (should be removed)"
else
  ok "erpbuket1_escape_grep_fixed removed"
fi

# --- template render (source install-nginx helpers without main) ---
note "template render HTTP/HTTPS"
export ALLOW_NONSTANDARD_APP_DIR=1
export ERP_ENV_FILE="${TMP}/production.env"
export ERP_NGINX_AVAILABLE="${TMP}/sites-available/erpbuket1.conf"
export ERP_NGINX_ENABLED="${TMP}/sites-enabled/erpbuket1.conf"
export ERP_ACME_WEBROOT="${TMP}/acme"
export ERP_SKIP_NGINX_BINARY=1
export ERP_SKIP_LOCK=1
export ERP_LOCK_FILE="${TMP}/ops.lock"
export ERP_NGINX_SCAN_GLOBS="${TMP}/sites-enabled/* ${TMP}/conf.d/*.conf"

cat >"${ERP_ENV_FILE}" <<EOF
ERP_DOMAIN=wh.buketnomer1.by
WEB_URL=https://wh.buketnomer1.by
NEXT_PUBLIC_API_URL=https://wh.buketnomer1.by
ERP_WEB_PORT=3100
ERP_API_PORT=3101
NODE_ENV=production
TRUST_PROXY=1
BUSINESS_TIME_ZONE=Europe/Minsk
POSTGRES_USER=erpbuket1
POSTGRES_PASSWORD=UrlSafePassword123
POSTGRES_DB=flower_crm
DATABASE_URL=postgresql://erpbuket1:UrlSafePassword123@postgres:5432/flower_crm?schema=public
JWT_ACCESS_SECRET=testjwtsecretvaluewithenoughlength123456
EOF
chmod 600 "${ERP_ENV_FILE}"

# Link shop into scan path to ensure collision detection sees it
ln -sfn "${shop_conf}" "${TMP}/sites-enabled/shop.conf"

# Source install-nginx functions
# shellcheck disable=SC1091
source "${ROOT}/deploy/scripts/install-nginx.sh"

MODE=http
ERP_TMP_DIR="${TMP}/render"
mkdir -p "${ERP_TMP_DIR}"
render_template "${ROOT}/deploy/nginx/erpbuket1.conf.template" "${ERP_TMP_DIR}/http.conf"
grep -F "server_name wh.buketnomer1.by;" "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "HTTP render domain" || bad "HTTP render domain"
grep -F "127.0.0.1:3100" "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "HTTP render web port" || bad "HTTP render web port"
grep -F "127.0.0.1:3101" "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "HTTP render api port" || bad "HTTP render api port"
grep -F "proxy_pass http://erpbuket1_api_upstream;" "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "HTTP API proxy preserves URI" || bad "HTTP API proxy"
grep -F ".well-known/acme-challenge" "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "HTTP ACME location" || bad "HTTP ACME"
grep -F "erpbuket1_web_upstream" "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "ERP-only upstream names" || bad "upstream names"
! grep -E '__ERP_|__SSL_' "${ERP_TMP_DIR}/http.conf" >/dev/null && ok "no leftover placeholders HTTP" || bad "placeholders HTTP"

MODE=https
render_template "${ROOT}/deploy/nginx/erpbuket1.ssl.conf.template" "${ERP_TMP_DIR}/https.conf"
grep -F "listen 443 ssl" "${ERP_TMP_DIR}/https.conf" >/dev/null && ok "HTTPS listen 443" || bad "HTTPS listen"
grep -F "return 301 https://" "${ERP_TMP_DIR}/https.conf" >/dev/null && ok "HTTP->HTTPS redirect" || bad "redirect"
! grep -F "Strict-Transport-Security" "${ERP_TMP_DIR}/https.conf" | grep -v '^[[:space:]]*#' >/dev/null && ok "HSTS not forced by default" || bad "HSTS still active"
grep -F "proxy_pass http://erpbuket1_api_upstream;" "${ERP_TMP_DIR}/https.conf" >/dev/null && ok "HTTPS API proxy" || bad "HTTPS API proxy"

# --- collision: our domain free vs shop; die() exits so use subshells ---
note "collision detection"
if ( assert_no_foreign_server_name_collision "wh.buketnomer1.by" ); then
  ok "no collision with shop.nasytko.ru for ERP domain"
else
  bad "false collision for ERP domain"
fi
# Put ERP domain into a foreign enabled file
cp "${erp_conf}" "${TMP}/sites-enabled/foreign-erp.conf"
if ( assert_no_foreign_server_name_collision "wh.buketnomer1.by" ); then
  bad "should detect foreign server_name collision"
else
  ok "detects foreign server_name collision"
fi
rm -f "${TMP}/sites-enabled/foreign-erp.conf"
# conf.d collision
cat >"${confd}" <<'EOF'
server_name wh.buketnomer1.by;
EOF
if ( assert_no_foreign_server_name_collision "wh.buketnomer1.by" ); then
  bad "should detect conf.d server_name collision"
else
  ok "detects conf.d server_name collision"
fi
cat >"${confd}" <<'EOF'
server_name unused.example.com;
EOF

# Shop domain must not be claimed as ours — installing ERP must not rewrite shop file
shop_before="$(cksum "${shop_conf}" | awk '{print $1}')"
ln -sfn "${shop_conf}" "${TMP}/sites-enabled/shop.conf"

# --- install once (test mode) + idempotent re-run + rollback ---
note "install idempotent + rollback"
CONFIRM_NGINX_INSTALL=YES ERP_SKIP_NGINX_BINARY=1 ERP_SKIP_LOCK=1 ALLOW_NONSTANDARD_APP_DIR=1 \
  bash "${ROOT}/deploy/scripts/install-nginx.sh" --mode=http
[[ -f "${ERP_NGINX_AVAILABLE}" ]] && ok "first install wrote available" || bad "first install available"
if [[ -L "${ERP_NGINX_ENABLED}" || -f "${ERP_NGINX_ENABLED}" ]]; then
  ok "first install created enabled path (symlink or test-mode copy)"
else
  bad "enabled path missing"
fi
chmod 600 "${ERP_ENV_FILE}" 2>/dev/null || true
shop_after="$(cksum "${shop_conf}" | awk '{print $1}')"
assert_eq "${shop_after}" "${shop_before}" "shop config unchanged after install"

CONFIRM_NGINX_INSTALL=YES ERP_SKIP_NGINX_BINARY=1 ERP_SKIP_LOCK=1 ALLOW_NONSTANDARD_APP_DIR=1 \
  bash "${ROOT}/deploy/scripts/install-nginx.sh" --mode=http
[[ -f "${ERP_NGINX_AVAILABLE}.bak."* ]] || ls "${ERP_NGINX_AVAILABLE}".bak.* >/dev/null 2>&1
if compgen -G "${ERP_NGINX_AVAILABLE}.bak.*" >/dev/null; then
  ok "reinstall created ERP backup"
else
  bad "reinstall should backup previous ERP config"
fi
shop_after2="$(cksum "${shop_conf}" | awk '{print $1}')"
assert_eq "${shop_after2}" "${shop_before}" "shop config unchanged after reinstall"

# Simulate rollback of first-time write (no prior available): remove and restore_nginx_state path
note "rollback removes first-time files"
# Re-source to get restore with current globals — exercise restore_nginx_state manually
BACKUP=""
ENABLED_WAS_PRESENT=0
ENABLED_PREV_LINK=""
NGINX_WRITE_STARTED=1
# Pretend we just wrote; capture was not present
rm -f "${ERP_NGINX_ENABLED}" "${ERP_NGINX_AVAILABLE}"
# recreate as "written"
echo "broken" >"${ERP_NGINX_AVAILABLE}"
ln -sfn "${ERP_NGINX_AVAILABLE}" "${ERP_NGINX_ENABLED}"
ENABLED_WAS_PRESENT=0
ENABLED_PREV_LINK=""
BACKUP=""
ERP_SKIP_NGINX_BINARY=1
restore_nginx_state
[[ ! -e "${ERP_NGINX_AVAILABLE}" ]] && ok "rollback removed available (first install)" || bad "available still present"
[[ ! -e "${ERP_NGINX_ENABLED}" ]] && ok "rollback removed enabled symlink" || bad "enabled still present"

# Rollback with prior backup + prior symlink
note "rollback restores prior content and symlink"
echo "good-config" >"${ERP_NGINX_AVAILABLE}"
ln -sfn "${ERP_NGINX_AVAILABLE}" "${ERP_NGINX_ENABLED}"
BACKUP="${ERP_NGINX_AVAILABLE}.bak.test"
cp -a "${ERP_NGINX_AVAILABLE}" "${BACKUP}"
echo "bad-config" >"${ERP_NGINX_AVAILABLE}"
ENABLED_WAS_PRESENT=1
ENABLED_PREV_LINK="${ERP_NGINX_AVAILABLE}"
ERP_SKIP_NGINX_BINARY=1
restore_nginx_state
got="$(cat "${ERP_NGINX_AVAILABLE}")"
assert_eq "${got}" "good-config" "rollback restored available content"
[[ -e "${ERP_NGINX_ENABLED}" ]] && ok "rollback kept enabled path" || bad "enabled missing after restore"

# --- bash -n ---
note "bash -n"
bash_n_fail=0
for s in \
  "${ROOT}/deploy/scripts/lib/erpbuket1-env.sh" \
  "${ROOT}/deploy/scripts/install-nginx.sh" \
  "${ROOT}/deploy/scripts/issue-cert.sh" \
  "${ROOT}/deploy/scripts/tests/test-nginx-install.sh"
do
  if bash -n "${s}"; then ok "bash -n $(basename "${s}")"; else bad "bash -n $(basename "${s}")"; bash_n_fail=1; fi
done

echo
echo "=== RESULTS: PASS=${PASS} FAIL=${FAIL} ==="
[[ "${FAIL}" -eq 0 ]]
