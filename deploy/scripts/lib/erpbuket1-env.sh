# Shared erpbuket1 helpers (sourced by deploy scripts).
# shellcheck shell=bash
#
# NEVER source/eval the contents of production.env into the shell.
# Read keys with erpbuket1_env_get / erpbuket1_env_has only.

ERP_ENV_FILE="${ERP_ENV_FILE:-/etc/erpbuket1/production.env}"
COMPOSE_FILE="${COMPOSE_FILE:-}"
ERP_APP_DIR_DEFAULT="/opt/erpbuket1"
ERP_BACKUP_DIR_DEFAULT="/var/backups/erpbuket1"
ERP_ENV_DIR_DEFAULT="/etc/erpbuket1"
ERP_STATE_DIR_DEFAULT="/var/lib/erpbuket1"
ERP_INSTALL_MARKER="${ERP_STATE_DIR_DEFAULT}/install.marker"
ERP_COMPOSE_PROJECT="erpbuket1"
ERP_VOLUME_NAME="erpbuket1_postgres_data"
ERP_NETWORK_NAME="erpbuket1_internal"
ERP_LOCK_FILE="${ERP_LOCK_FILE:-/var/lock/erpbuket1-ops.lock}"
ERP_SHOP_COMPOSE_HINT="${ERP_SHOP_COMPOSE_HINT:-shopbuket1}"
ERP_NGINX_AVAILABLE="${ERP_NGINX_AVAILABLE:-/etc/nginx/sites-available/erpbuket1.conf}"
ERP_NGINX_ENABLED="${ERP_NGINX_ENABLED:-/etc/nginx/sites-enabled/erpbuket1.conf}"
ERP_ACME_WEBROOT="${ERP_ACME_WEBROOT:-/var/www/erpbuket1-acme}"

# ---------------------------------------------------------------------------
# Logging / errors
# ---------------------------------------------------------------------------

# Logs MUST go to stderr so command substitution never captures them as data.
erpbuket1_log() { echo "[erpbuket1] $*" >&2; }
erpbuket1_warn() { echo "[erpbuket1] WARNING: $*" >&2; }
erpbuket1_die() { echo "[erpbuket1] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

erpbuket1_root_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd
}

erpbuket1_require_app_dir() {
  local root
  root="$(erpbuket1_root_dir)"
  if [[ "${root}" != "${ERP_APP_DIR_DEFAULT}" && "${ALLOW_NONSTANDARD_APP_DIR:-}" != "1" ]]; then
    erpbuket1_die "Expected app at ${ERP_APP_DIR_DEFAULT} (got ${root}). Clone/pull there, or set ALLOW_NONSTANDARD_APP_DIR=1."
  fi
}

# ---------------------------------------------------------------------------
# Env file access (no source/eval)
# ---------------------------------------------------------------------------

erpbuket1_strip_quotes() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ "${v}" == \"*\" && "${v}" == *\" ]]; then
    v="${v:1:${#v}-2}"
  elif [[ "${v}" == \'*\' && "${v}" == *\' ]]; then
    v="${v:1:${#v}-2}"
  fi
  printf '%s' "${v}"
}

erpbuket1_env_get() {
  local key="$1"
  local line raw
  [[ -f "${ERP_ENV_FILE}" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "${ERP_ENV_FILE}" | tail -n1 || true)"
  [[ -n "${line}" ]] || return 0
  raw="${line#*=}"
  raw="$(printf '%s' "${raw}" | tr -d '\r')"
  erpbuket1_strip_quotes "${raw}"
}

erpbuket1_env_has() {
  local key="$1"
  local val
  val="$(erpbuket1_env_get "${key}")"
  [[ -n "${val}" ]]
}

erpbuket1_require_env_file() {
  if [[ ! -f "${ERP_ENV_FILE}" ]]; then
    erpbuket1_die "missing env file: ${ERP_ENV_FILE} (copy deploy/env/production.env.example, chmod 600)"
  fi
  if [[ -L "${ERP_ENV_FILE}" ]]; then
    erpbuket1_warn "env file is a symlink: ${ERP_ENV_FILE}"
  fi
  local mode
  mode="$(stat -c '%a' "${ERP_ENV_FILE}" 2>/dev/null || stat -f '%OLp' "${ERP_ENV_FILE}" 2>/dev/null || echo "")"
  if [[ -n "${mode}" && "${mode}" != "600" && "${mode}" != "400" ]]; then
    erpbuket1_warn "production.env mode is ${mode} (recommend 600)"
  fi
}

erpbuket1_load_ports() {
  ERP_WEB_PORT="$(erpbuket1_env_get ERP_WEB_PORT)"
  ERP_API_PORT="$(erpbuket1_env_get ERP_API_PORT)"
  ERP_WEB_PORT="${ERP_WEB_PORT:-3100}"
  ERP_API_PORT="${ERP_API_PORT:-3101}"
  if ! [[ "${ERP_WEB_PORT}" =~ ^[0-9]+$ && "${ERP_API_PORT}" =~ ^[0-9]+$ ]]; then
    erpbuket1_die "ERP_WEB_PORT / ERP_API_PORT must be numeric"
  fi
  if (( ERP_WEB_PORT < 1 || ERP_WEB_PORT > 65535 || ERP_API_PORT < 1 || ERP_API_PORT > 65535 )); then
    erpbuket1_die "ports out of range"
  fi
}

erpbuket1_load_public_identity() {
  ERP_DOMAIN="$(erpbuket1_env_get ERP_DOMAIN)"
  WEB_URL="$(erpbuket1_env_get WEB_URL)"
  NEXT_PUBLIC_API_URL="$(erpbuket1_env_get NEXT_PUBLIC_API_URL)"
}

# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

erpbuket1_compose() {
  local root
  root="$(erpbuket1_root_dir)"
  if [[ -z "${COMPOSE_FILE}" ]]; then
    COMPOSE_FILE="${root}/docker-compose.prod.yml"
  fi
  erpbuket1_require_env_file
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    erpbuket1_die "compose file not found: ${COMPOSE_FILE}"
  fi
  docker compose --env-file "${ERP_ENV_FILE}" -f "${COMPOSE_FILE}" --project-name "${ERP_COMPOSE_PROJECT}" "$@"
}

# ---------------------------------------------------------------------------
# URL encode / credential consistency (never print secrets)
# ---------------------------------------------------------------------------

erpbuket1_urlencode() {
  local raw="$1"
  if erpbuket1_need_cmd python3; then
    python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${raw}"
    return 0
  fi
  return 1
}

erpbuket1_credentials_match_database_url() {
  # Exit 0 match, 1 mismatch, 2 cannot verify (caller must fail closed)
  local user db pass database_url enc expected
  user="$(erpbuket1_env_get POSTGRES_USER)"
  db="$(erpbuket1_env_get POSTGRES_DB)"
  pass="$(erpbuket1_env_get POSTGRES_PASSWORD)"
  database_url="$(erpbuket1_env_get DATABASE_URL)"

  [[ -n "${user}" && -n "${db}" && -n "${pass}" && -n "${database_url}" ]] || return 1

  if [[ "${pass}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    expected="postgresql://${user}:${pass}@postgres:5432/${db}?schema=public"
    if [[ "${database_url}" == "${expected}" || "${database_url}" == "postgres://${user}:${pass}@postgres:5432/${db}?schema=public" ]]; then
      return 0
    fi
    return 1
  fi

  if enc="$(erpbuket1_urlencode "${pass}")"; then
    expected="postgresql://${user}:${enc}@postgres:5432/${db}?schema=public"
    if [[ "${database_url}" == "${expected}" || "${database_url}" == "postgres://${user}:${enc}@postgres:5432/${db}?schema=public" ]]; then
      return 0
    fi
    return 1
  fi

  return 2
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

erpbuket1_validate_env() {
  local missing=0
  local key val
  local required=(
    ERP_DOMAIN WEB_URL NEXT_PUBLIC_API_URL
    ERP_WEB_PORT ERP_API_PORT
    NODE_ENV TRUST_PROXY BUSINESS_TIME_ZONE
    POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL
    JWT_ACCESS_SECRET
  )

  erpbuket1_require_env_file

  for key in "${required[@]}"; do
    val="$(erpbuket1_env_get "${key}")"
    if [[ -z "${val}" ]]; then
      erpbuket1_warn "missing required key: ${key}"
      missing=1
      continue
    fi
    case "${key}" in
      POSTGRES_PASSWORD|JWT_ACCESS_SECRET|DATABASE_URL)
        if [[ "${val}" == *CHANGE_ME* ]]; then
          erpbuket1_warn "placeholder not replaced: ${key}"
          missing=1
        fi
        ;;
      ERP_DOMAIN|WEB_URL|NEXT_PUBLIC_API_URL)
        if [[ "${val}" == *example.com* ]]; then
          erpbuket1_warn "placeholder domain still set: ${key}"
          missing=1
        fi
        ;;
    esac
  done

  local user db database_url domain web_url next_url node_env
  user="$(erpbuket1_env_get POSTGRES_USER)"
  db="$(erpbuket1_env_get POSTGRES_DB)"
  database_url="$(erpbuket1_env_get DATABASE_URL)"

  if [[ -n "${database_url}" ]]; then
    if [[ "${database_url}" != postgresql://* && "${database_url}" != postgres://* ]]; then
      erpbuket1_warn "DATABASE_URL must start with postgresql:// or postgres://"
      missing=1
    fi
    if [[ "${database_url}" != *"@postgres:5432/"* ]]; then
      erpbuket1_warn "DATABASE_URL host must be compose service 'postgres' on port 5432"
      missing=1
    fi
    if [[ -n "${user}" && "${database_url}" != "postgresql://${user}:"* && "${database_url}" != "postgres://${user}:"* ]]; then
      erpbuket1_warn "DATABASE_URL user does not match POSTGRES_USER (values not shown)"
      missing=1
    fi
    if [[ -n "${db}" && "${database_url}" != *"/${db}?"* && "${database_url}" != *"/${db}" ]]; then
      erpbuket1_warn "DATABASE_URL database name does not match POSTGRES_DB (values not shown)"
      missing=1
    fi

    local cred_rc=0
    erpbuket1_credentials_match_database_url || cred_rc=$?
    if [[ "${cred_rc}" -eq 1 ]]; then
      erpbuket1_warn "DATABASE_URL credentials do not match POSTGRES_* (values not shown)"
      missing=1
    elif [[ "${cred_rc}" -eq 2 ]]; then
      erpbuket1_warn "cannot verify DATABASE_URL password encoding (need python3 or URL-safe password) -- fail closed"
      missing=1
    fi
  fi

  domain="$(erpbuket1_env_get ERP_DOMAIN)"
  web_url="$(erpbuket1_env_get WEB_URL)"
  next_url="$(erpbuket1_env_get NEXT_PUBLIC_API_URL)"
  if [[ -n "${domain}" ]] && ! erpbuket1_validate_hostname "${domain}"; then
    erpbuket1_warn "ERP_DOMAIN is not a valid DNS hostname"
    missing=1
  fi
  if [[ -n "${web_url}" && -n "${next_url}" && "${web_url}" != "${next_url}" ]]; then
    erpbuket1_warn "WEB_URL and NEXT_PUBLIC_API_URL differ (same-origin cookies expect equality)"
    missing=1
  fi
  if [[ -n "${domain}" && -n "${web_url}" && "${web_url}" != "https://${domain}" && "${web_url}" != "http://${domain}" ]]; then
    erpbuket1_warn "WEB_URL does not look like http(s)://\${ERP_DOMAIN}"
  fi

  node_env="$(erpbuket1_env_get NODE_ENV)"
  if [[ -n "${node_env}" && "${node_env}" != "production" ]]; then
    erpbuket1_warn "NODE_ENV is not 'production'"
    missing=1
  fi

  erpbuket1_load_ports
  if [[ "${ERP_WEB_PORT}" == "${ERP_API_PORT}" ]]; then
    erpbuket1_warn "ERP_WEB_PORT and ERP_API_PORT must differ"
    missing=1
  fi

  [[ "${missing}" == "0" ]] || erpbuket1_die "production.env validation failed (see warnings above; secrets not printed)"
}

# ---------------------------------------------------------------------------
# ERP state detection
# ---------------------------------------------------------------------------

erpbuket1_volume_exists() {
  docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${ERP_VOLUME_NAME}"
}

erpbuket1_marker_exists() {
  [[ -f "${ERP_INSTALL_MARKER}" ]]
}

erpbuket1_write_install_marker() {
  mkdir -p "${ERP_STATE_DIR_DEFAULT}"
  chmod 755 "${ERP_STATE_DIR_DEFAULT}" || true
  {
    echo "project=${ERP_COMPOSE_PROJECT}"
    echo "volume=${ERP_VOLUME_NAME}"
    echo "installed_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "git_sha=$(git -C "$(erpbuket1_root_dir)" rev-parse HEAD 2>/dev/null || echo unknown)"
  } >"${ERP_INSTALL_MARKER}"
  chmod 644 "${ERP_INSTALL_MARKER}" || true
}

erpbuket1_backup_dumps_exist() {
  local dir="${BACKUP_DIR:-${ERP_BACKUP_DIR_DEFAULT}}"
  [[ -d "${dir}" ]] || return 1
  compgen -G "${dir}/erpbuket1_*.dump" >/dev/null 2>&1
}

erpbuket1_compose_containers_exist() {
  local n
  n="$(docker ps -a --filter "label=com.docker.compose.project=${ERP_COMPOSE_PROJECT}" --format '{{.ID}}' 2>/dev/null | head -n1 || true)"
  [[ -n "${n}" ]]
}

# Host evidence that THIS VPS previously ran ERP with a postgres volume.
# Intentionally EXCLUDES: dump files (may be imported for migration) and Nginx
# vhost alone (may be prepared before DB exists).
erpbuket1_host_install_evidence() {
  erpbuket1_marker_exists && return 0
  erpbuket1_compose_containers_exist && return 0
  return 1
}

# True when Docker volume carries compose labels for this project.
erpbuket1_volume_labeled_for_project() {
  erpbuket1_volume_exists || return 1
  local labels proj
  labels="$(docker volume inspect "${ERP_VOLUME_NAME}" --format '{{json .Labels}}' 2>/dev/null || echo null)"
  [[ "${labels}" != "null" && -n "${labels}" && "${labels}" != "{}" ]] || return 1
  proj="$(docker volume inspect "${ERP_VOLUME_NAME}" --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  [[ "${proj}" == "${ERP_COMPOSE_PROJECT}" ]]
}

# Marker names our volume (weak alone; combined with volume existence).
erpbuket1_marker_claims_volume() {
  erpbuket1_marker_exists || return 1
  grep -q "^volume=${ERP_VOLUME_NAME}$" "${ERP_INSTALL_MARKER}" 2>/dev/null
}

# Provenance: volume belongs to erpbuket1 (labels and/or install marker).
erpbuket1_volume_provenance_ok() {
  erpbuket1_volume_exists || return 1
  erpbuket1_volume_labeled_for_project && return 0
  erpbuket1_marker_claims_volume && return 0
  return 1
}

erpbuket1_die_lost_volume() {
  erpbuket1_die "LOST VOLUME: PostgreSQL volume '${ERP_VOLUME_NAME}' is missing but this host shows prior ERP install evidence (install.marker and/or erpbuket1 compose containers). Refusing to create an empty database. CONFIRM_CREATE_EMPTY_DB cannot bypass this. See docs/deployment.md — Disaster recovery. Dump files alone are NOT treated as lost_volume."
}

erpbuket1_die_volume_unproven() {
  erpbuket1_die "VOLUME UNPROVEN: '${ERP_VOLUME_NAME}' exists with ${ERP_ENV_FILE}, but has no com.docker.compose.project=${ERP_COMPOSE_PROJECT} label and no matching install.marker. Refusing automatic use of an unlabeled volume. Inspect: docker volume inspect ${ERP_VOLUME_NAME}. If it is ERP data, recreate marker after manual verification (see docs), then re-run. Never attach a shop volume."
}

# Prints one of:
#   fresh | existing | volume_unproven | ambiguous_volume_without_env
#   interrupted_first_install | lost_volume
erpbuket1_detect_db_state() {
  local has_vol=0 has_env=0
  erpbuket1_volume_exists && has_vol=1
  [[ -f "${ERP_ENV_FILE}" ]] && has_env=1

  if erpbuket1_backup_dumps_exist; then
    erpbuket1_log "note: erpbuket1_*.dump files present under backup dir (informational; not lost_volume by themselves)"
  fi

  if [[ "${has_vol}" -eq 1 && "${has_env}" -eq 0 ]]; then
    echo "ambiguous_volume_without_env"
    return 0
  fi

  if [[ "${has_vol}" -eq 1 && "${has_env}" -eq 1 ]]; then
    if erpbuket1_volume_provenance_ok; then
      echo "existing"
      return 0
    fi
    echo "volume_unproven"
    return 0
  fi

  # Volume missing
  if erpbuket1_host_install_evidence; then
    echo "lost_volume"
    return 0
  fi
  if [[ "${has_env}" -eq 1 ]]; then
    echo "interrupted_first_install"
    return 0
  fi
  echo "fresh"
}

erpbuket1_require_safe_db_state_for_deploy() {
  local state
  state="$(erpbuket1_detect_db_state)"
  case "${state}" in
    fresh|existing)
      erpbuket1_log "DB state: ${state}"
      ;;
    interrupted_first_install)
      if [[ "${CONFIRM_CREATE_EMPTY_DB:-}" == "YES" ]]; then
        erpbuket1_warn "CONFIRM_CREATE_EMPTY_DB=YES -- interrupted first install; creating NEW empty volume"
      else
        erpbuket1_die "DB state=interrupted_first_install: ${ERP_ENV_FILE} exists, volume missing, no host install evidence. Set CONFIRM_CREATE_EMPTY_DB=YES to finish first install, or restore volume. (lost_volume cannot use this flag.)"
      fi
      ;;
    volume_unproven)
      if [[ "${CONFIRM_VOLUME_IS_ERP_DATA:-}" == "YES" ]]; then
        erpbuket1_warn "CONFIRM_VOLUME_IS_ERP_DATA=YES -- operator asserts unlabeled volume is ERP data"
      else
        erpbuket1_die_volume_unproven
      fi
      ;;
    ambiguous_volume_without_env)
      erpbuket1_die "DB state ambiguous: volume ${ERP_VOLUME_NAME} exists but ${ERP_ENV_FILE} is missing. Restore env manually; refusing to invent credentials."
      ;;
    lost_volume)
      erpbuket1_die_lost_volume
      ;;
    *)
      erpbuket1_die "unknown DB state: ${state}"
      ;;
  esac
  printf '%s' "${state}"
}

# DNS hostname only (labels / FQDN). Rejects sed/shell metacharacters.
erpbuket1_validate_hostname() {
  local h="$1"
  [[ -n "${h}" ]] || return 1
  ((${#h} <= 253)) || return 1
  [[ "${h}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]]
}

erpbuket1_escape_grep_fixed() {
  # Escape basic regex metacharacters for literal match in grep -E
  printf '%s' "$1" | sed -e 's/[.[\\*^$()+?{|]/g'
}

# Resolve domain and optionally require it matches a local IPv4 address.
erpbuket1_dns_addresses() {
  local domain="$1"
  local out=""
  if erpbuket1_need_cmd getent; then
    out="$(getent ahostsv4 "${domain}" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  fi
  if [[ -z "${out}" ]] && erpbuket1_need_cmd dig; then
    out="$(dig +short A "${domain}" 2>/dev/null | sort -u || true)"
  fi
  printf '%s' "${out}"
}

erpbuket1_host_ipv4_list() {
  if erpbuket1_need_cmd hostname; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true
  fi
  if erpbuket1_need_cmd ip; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true
  fi
}

erpbuket1_dns_points_here() {
  local domain="$1" resolved local_ips r
  resolved="$(erpbuket1_dns_addresses "${domain}")"
  [[ -n "${resolved}" ]] || return 1
  local_ips="$(erpbuket1_host_ipv4_list | sort -u)"
  [[ -n "${local_ips}" ]] || return 2
  while IFS= read -r r; do
    [[ -n "${r}" ]] || continue
    if printf '%s\n' "${local_ips}" | grep -qx "${r}"; then
      return 0
    fi
  done <<<"${resolved}"
  return 1
}

# ---------------------------------------------------------------------------
# Host / Docker preflight
# ---------------------------------------------------------------------------

erpbuket1_need_cmd() {
  local c="$1"
  command -v "${c}" >/dev/null 2>&1 || return 1
  return 0
}

erpbuket1_check_commands() {
  local missing=()
  local c
  for c in "$@"; do
    erpbuket1_need_cmd "${c}" || missing+=("${c}")
  done
  if ((${#missing[@]} > 0)); then
    erpbuket1_die "missing commands: ${missing[*]}"
  fi
}

erpbuket1_check_docker() {
  erpbuket1_check_commands docker
  docker compose version >/dev/null 2>&1 || erpbuket1_die "docker compose plugin not available"
  docker info >/dev/null 2>&1 || erpbuket1_die "docker daemon not reachable (is Docker running?)"
}

erpbuket1_port_listening() {
  local port="$1"
  if erpbuket1_need_cmd ss; then
    if ss -lntH "sport = :${port}" 2>/dev/null | grep -q .; then
      return 0
    fi
    if ss -lnt 2>/dev/null | awk '{print $4}' | grep -E ":${port}$" >/dev/null; then
      return 0
    fi
  fi
  if erpbuket1_need_cmd lsof; then
    lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  # Docker may publish even when ss output is noisy -- also probe via docker
  if docker ps --format '{{.Ports}}' 2>/dev/null | grep -E "(:|,)${port}->" >/dev/null; then
    return 0
  fi
  return 1
}

# Echo compose project name owning a published host port, or empty.
erpbuket1_docker_publish_project() {
  local port="$1"
  local proj
  proj="$(docker ps --filter "publish=${port}" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | head -n1 || true)"
  if [[ -n "${proj}" ]]; then
    printf '%s' "${proj}"
    return 0
  fi
  # Secondary: scan Port bindings text for loopback publish
  local id ports
  while IFS=$'\t' read -r id ports; do
    [[ -n "${id}" ]] || continue
    if [[ "${ports}" == *":${port}->"* ]]; then
      proj="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${id}" 2>/dev/null || true)"
      printf '%s' "${proj}"
      return 0
    fi
  done < <(docker ps --format $'{{.ID}}\t{{.Ports}}' 2>/dev/null || true)
  printf ''
}

erpbuket1_port_owned_by_project() {
  local port="$1"
  local owner
  owner="$(erpbuket1_docker_publish_project "${port}")"
  [[ "${owner}" == "${ERP_COMPOSE_PROJECT}" ]]
}

erpbuket1_check_ports_available() {
  erpbuket1_load_ports
  local p owner
  for p in "${ERP_WEB_PORT}" "${ERP_API_PORT}"; do
    if ! erpbuket1_port_listening "${p}"; then
      erpbuket1_log "port ${p} is free"
      continue
    fi
    owner="$(erpbuket1_docker_publish_project "${p}")"
    if [[ "${owner}" == "${ERP_COMPOSE_PROJECT}" ]]; then
      erpbuket1_log "port ${p} owned by ${ERP_COMPOSE_PROJECT} (OK)"
      continue
    fi
    if [[ -n "${owner}" ]]; then
      erpbuket1_die "host port ${p} is published by Docker project '${owner}' (not ${ERP_COMPOSE_PROJECT}). Change ERP_*_PORT or free the port."
    fi
    # Listening but not attributable to our project -- fail closed
    erpbuket1_die "host port ${p} is in use by an unknown process (fail closed). Free it or change ERP_WEB_PORT/ERP_API_PORT."
  done
}

erpbuket1_check_shop_coexistence() {
  if docker compose ls 2>/dev/null | grep -qi "${ERP_SHOP_COMPOSE_HINT}"; then
    erpbuket1_log "detected compose project hint '${ERP_SHOP_COMPOSE_HINT}' -- coexistence expected; ports must not overlap"
  fi
  if docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx "${ERP_NETWORK_NAME}"; then
    erpbuket1_log "network ${ERP_NETWORK_NAME} already exists (OK for reinstall/update)"
  fi
  if erpbuket1_volume_exists; then
    erpbuket1_log "volume ${ERP_VOLUME_NAME} present (will never wipe)"
  fi
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Eiq '^(newerp_postgres_data|flower_crm_postgres_data)$'; then
    erpbuket1_warn "legacy postgres volume name(s) detected; erpbuket1 uses only ${ERP_VOLUME_NAME}"
  fi
}

erpbuket1_postgres_service_running() {
  erpbuket1_compose ps --status running --services 2>/dev/null | grep -qx postgres
}

erpbuket1_ensure_postgres_ready() {
  local retries="${1:-45}"
  local sleep_s="${2:-2}"
  local i
  erpbuket1_compose up -d postgres || erpbuket1_die "failed to start postgres"
  for i in $(seq 1 "${retries}"); do
    if erpbuket1_compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      erpbuket1_log "postgres ready"
      return 0
    fi
    sleep "${sleep_s}"
  done
  erpbuket1_die "postgres did not become ready"
}

erpbuket1_check_resources() {
  local mem_kb disk_avail_kb cpus
  cpus="$(nproc 2>/dev/null || echo 1)"
  erpbuket1_log "CPU cores: ${cpus}"
  if [[ -r /proc/meminfo ]]; then
    mem_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || awk '/MemTotal:/ {print $2}' /proc/meminfo)"
    erpbuket1_log "Memory available (kB): ${mem_kb:-unknown}"
    if [[ -n "${mem_kb}" && "${mem_kb}" -lt 900000 ]]; then
      erpbuket1_warn "low available RAM (<~900MB); Docker build may fail or swap heavily"
    fi
  fi
  if erpbuket1_need_cmd df; then
    disk_avail_kb="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')"
    if [[ -z "${disk_avail_kb}" ]]; then
      disk_avail_kb="$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')"
    fi
    erpbuket1_log "Disk available (kB) near Docker data: ${disk_avail_kb:-unknown}"
    if [[ -n "${disk_avail_kb}" && "${disk_avail_kb}" -lt 5000000 ]]; then
      erpbuket1_warn "low disk (<~5GB free); image build may fail"
    fi
    if [[ -n "${disk_avail_kb}" && "${disk_avail_kb}" -lt 1000000 ]]; then
      erpbuket1_die "insufficient disk (<~1GB free)"
    fi
  fi
}

erpbuket1_check_dns_warn() {
  local domain resolved rc
  domain="$(erpbuket1_env_get ERP_DOMAIN)"
  [[ -n "${domain}" ]] || return 0
  if ! erpbuket1_need_cmd getent && ! erpbuket1_need_cmd dig; then
    erpbuket1_warn "no DNS lookup tool (getent/dig); skip ERP_DOMAIN resolution check"
    return 0
  fi
  resolved="$(erpbuket1_dns_addresses "${domain}")"
  if [[ -z "${resolved}" ]]; then
    erpbuket1_warn "ERP_DOMAIN '${domain}' did not resolve -- Nginx/Certbot will need DNS"
    return 0
  fi
  erpbuket1_log "ERP_DOMAIN resolves to: $(printf '%s' "${resolved}" | tr '\n' ' ')"
  erpbuket1_dns_points_here "${domain}" && rc=0 || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    erpbuket1_log "DNS appears to point at this host"
  elif [[ "${rc}" -eq 2 ]]; then
    erpbuket1_warn "could not list local IPv4 addresses; verify DNS manually"
  else
    erpbuket1_warn "ERP_DOMAIN does not match local IPv4 addresses — Certbot HTTP-01 will fail until DNS points here"
  fi
}

erpbuket1_require_dns() {
  local domain resolved rc
  domain="$(erpbuket1_env_get ERP_DOMAIN)"
  [[ -n "${domain}" ]] || erpbuket1_die "ERP_DOMAIN empty"
  erpbuket1_validate_hostname "${domain}" || erpbuket1_die "ERP_DOMAIN is not a valid DNS hostname"
  resolved="$(erpbuket1_dns_addresses "${domain}")"
  [[ -n "${resolved}" ]] || erpbuket1_die "ERP_DOMAIN '${domain}' does not resolve; fix DNS before certbot"
  erpbuket1_log "DNS resolves: ${domain} -> $(printf '%s' "${resolved}" | tr '\n' ' ')"
  erpbuket1_dns_points_here "${domain}" && rc=0 || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    erpbuket1_log "DNS points at this host (OK for HTTP-01)"
  elif [[ "${rc}" -eq 2 ]]; then
    erpbuket1_die "cannot verify local IPs vs DNS; refusing certbot"
  else
    erpbuket1_die "ERP_DOMAIN does not point at this VPS IPv4; refusing certbot (fix DNS A/AAAA)"
  fi
}

# ---------------------------------------------------------------------------
# Locking / cleanup
# ---------------------------------------------------------------------------

ERP_LOCK_FD=9

erpbuket1_acquire_lock() {
  local dir
  dir="$(dirname "${ERP_LOCK_FILE}")"
  mkdir -p "${dir}" 2>/dev/null || true
  if ! eval "exec ${ERP_LOCK_FD}>\"${ERP_LOCK_FILE}\""; then
    ERP_LOCK_FILE="$(erpbuket1_root_dir)/.erpbuket1-ops.lock"
    eval "exec ${ERP_LOCK_FD}>\"${ERP_LOCK_FILE}\"" || erpbuket1_die "cannot open lock file"
  fi
  if ! flock -n "${ERP_LOCK_FD}"; then
    erpbuket1_die "another install/deploy/nginx op is running (lock: ${ERP_LOCK_FILE})"
  fi
}

erpbuket1_setup_tmp_trap() {
  ERP_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/erpbuket1.XXXXXX")"
  # shellcheck disable=SC2064
  trap 'rm -rf "${ERP_TMP_DIR:-}"; exit 130' INT
  # shellcheck disable=SC2064
  trap 'rm -rf "${ERP_TMP_DIR:-}"; exit 143' TERM
  # shellcheck disable=SC2064
  trap 'rm -rf "${ERP_TMP_DIR:-}"' EXIT
}
