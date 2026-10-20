# Production deployment — erpbuket1 (HostFly)

ERP/CRM for the flower shop, deployed **independently** alongside the existing
internet shop `shopbuket1` on the same VPS.

| Item            | Value                                                         |
| --------------- | ------------------------------------------------------------- |
| App path        | `/opt/erpbuket1`                                              |
| Secrets         | `/etc/erpbuket1/production.env` (chmod 600, **outside Git**)  |
| Backups         | `/var/backups/erpbuket1` (chmod 700)                          |
| State marker    | `/var/lib/erpbuket1/install.marker`                           |
| Compose project | `erpbuket1`                                                   |
| Compose file    | `docker-compose.prod.yml`                                     |
| Loopback ports  | `127.0.0.1:3100` (web), `127.0.0.1:3101` (api) — configurable |
| Public surface  | Host Nginx `:80` / `:443` only                                |

**Installing or updating ERP must never modify shopbuket1 containers, volumes,
networks, or Nginx vhosts.**

> A new ERP install does **not** automatically migrate data from an old server.
> Data transfer is a separate, manual restore from an `erpbuket1_*.dump` backup.

---

## 1. Architecture and isolation from the shop

```text
Internet
   |
   v
Host Nginx :80/:443  (TLS for ERP_DOMAIN only)
   |
   +--> https://ERP_DOMAIN/              -> 127.0.0.1:ERP_WEB_PORT  (Next.js)
   +--> https://ERP_DOMAIN/api/...       -> 127.0.0.1:ERP_API_PORT  (NestJS api/v1)
   +--> https://ERP_DOMAIN/_next/static/ -> web (long cache)
                    |
                    v
             erpbuket1_postgres (Docker network erpbuket1_internal ONLY)
             volume: erpbuket1_postgres_data
```

Isolation:

| Resource        | ERP                                         | Shop (typical)   |
| --------------- | ------------------------------------------- | ---------------- |
| Compose project | `erpbuket1`                                 | `shopbuket1`     |
| Volume          | `erpbuket1_postgres_data`                   | shop-owned name  |
| Network         | `erpbuket1_internal`                        | shop-owned       |
| Host ports      | 3100/3101 loopback                          | other ports      |
| Nginx file      | `/etc/nginx/sites-available/erpbuket1.conf` | shop vhost files |
| Env             | `/etc/erpbuket1/production.env`             | shop env         |

PostgreSQL has **no host port**. API/Web bind **127.0.0.1 only**.

Same-origin cookies: `WEB_URL` and `NEXT_PUBLIC_API_URL` must both be
`https://ERP_DOMAIN`. Refresh cookie path is `/api/v1/auth` (Secure in production).
`TRUST_PROXY=1` so Nest trusts `X-Forwarded-*` from host Nginx.

---

## 2. VPS requirements

- Ubuntu 24.04 LTS (target)
- Docker Engine + Compose plugin
- Git, curl, openssl
- Host Nginx + Certbot (for public HTTPS)
- Free disk for images + dumps (several GB)
- UFW allowing 22/80/443 (operator-managed)
- Ports **3100** and **3101** free on loopback (or change in env)

Do **not** install ERP tooling into the shop project directory.

---

## 3. DNS

Create `A` / `AAAA` for `ERP_DOMAIN` pointing at this VPS **before** Certbot.

```bash
# On the VPS (example checks)
getent ahostsv4 your.erp.domain
```

Shop DNS records stay unchanged.

---

## 4. Obtain the repository

```bash
sudo mkdir -p /opt/erpbuket1
sudo chown "$USER":"$USER" /opt/erpbuket1
git clone https://github.com/Nasytko/flower-crm.git /opt/erpbuket1
cd /opt/erpbuket1
```

For non-standard paths set `ALLOW_NONSTANDARD_APP_DIR=1` on scripts.

---

## 5–9. First install (app stack)

Preferred single entrypoint (interactive env creation, postgres, migrate, api/web, internal healthcheck):

```bash
cd /opt/erpbuket1
./install.sh
# equivalent: ./deploy/scripts/install.sh
```

What `install.sh` does:

1. Preflight (Docker, disk, ports, shop coexistence hint)
2. Creates `/etc/erpbuket1/production.env` if missing (URL-safe secrets)
3. `docker compose build`
4. Starts **postgres**, waits for readiness
5. `prisma migrate deploy` (migrate service)
6. Starts **api** + **web**
7. `./deploy/scripts/healthcheck.sh --mode=internal`
8. Writes `/var/lib/erpbuket1/install.marker`

What it does **not** do: Nginx, Certbot, user bootstrap, `down -v`, shop changes.

### Manual env (non-interactive)

```bash
sudo mkdir -p /etc/erpbuket1 /var/backups/erpbuket1 /var/lib/erpbuket1
sudo cp deploy/env/production.env.example /etc/erpbuket1/production.env
sudo chmod 600 /etc/erpbuket1/production.env
sudo nano /etc/erpbuket1/production.env
# Replace every CHANGE_ME / example.com value.
# Keep WEB_URL == NEXT_PUBLIC_API_URL == https://ERP_DOMAIN
# DATABASE_URL host must be compose service "postgres"
NONINTERACTIVE=1 ./deploy/scripts/install.sh
```

### First DIRECTOR (manual, once)

Only on an empty User table:

```bash
CONFIRM_PRODUCTION_BOOTSTRAP=YES \
BOOTSTRAP_DIRECTOR_NAME='Your Name' \
BOOTSTRAP_DIRECTOR_LOGIN='your_login' \
BOOTSTRAP_DIRECTOR_EMAIL='you@example.com' \
BOOTSTRAP_DIRECTOR_PASSWORD='your-strong-password-min-10' \
  ./deploy/scripts/bootstrap-initial-users.sh
```

Never commit these credentials. Change the password after first login if desired.

---

## 10–12. Nginx, TLS, HTTPS check

**Separate confirmations** — never run from plain `install.sh` / `deploy.sh`.

### HTTP vhost + ACME webroot

```bash
CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh --mode=http
```

Creates/updates **only** `/etc/nginx/sites-available/erpbuket1.conf`,
`nginx -t`, then reload. Refuses duplicate `server_name` on other vhosts.
On failure restores the previous **ERP** file only (shop untouched).

### Certificate (webroot — does not use `certbot --nginx`)

```bash
CONFIRM_CERTBOT=YES CERTBOT_EMAIL=ops@example.com ./deploy/scripts/issue-cert.sh
```

Requires DNS and the HTTP ERP vhost. Writes cert under
`/etc/letsencrypt/live/ERP_DOMAIN/`. Shop certs are not modified.

### Enable HTTPS + redirect

```bash
CONFIRM_NGINX_INSTALL=YES ./deploy/scripts/install-nginx.sh --mode=https
./deploy/scripts/healthcheck.sh --mode=public
```

Renewal: host `certbot renew` timer/cron; dry-run: `certbot renew --dry-run`.

---

## 13. Update ERP

**Recommended one-command update** (fetch/pull + backup + build + migrate + restart + health):

```bash
cd /opt/erpbuket1
chmod +x deploy.sh install.sh deploy/scripts/*.sh   # once, if needed
./deploy.sh
```

Root `./deploy.sh`:

1. Confirms `/opt/erpbuket1`, git remote, and (by default) fast-forward pull of `DEPLOY_BRANCH` (default `main`)
2. Refuses dirty trees unless `ALLOW_DIRTY=1`
3. Delegates to `deploy/scripts/deploy.sh`

Inner `deploy/scripts/deploy.sh`:

1. flock lock, validate env, ports, shop coexistence hint
2. If DB **existing**: ensure postgres → **postgres dump + uploads archive** → build (while old containers keep serving) → `prisma migrate deploy` → `up -d api web`
3. Internal healthcheck + diagnostic log under `/var/log/erpbuket1/`
4. Does **not** modify Nginx/Certbot/shop; never `down -v` / `docker system prune`

Apply current tree without pulling:

```bash
SKIP_GIT_PULL=1 ./deploy.sh
# or:
./deploy/scripts/deploy.sh
```

Emergency skip backup (existing DB only):

```bash
SKIP_BACKUP=1 CONFIRM_SKIP_BACKUP=YES I_UNDERSTAND_DATA_LOSS_RISK=YES \
  ./deploy.sh
```

Dirty tree: `ALLOW_DIRTY=1 ./deploy.sh`

---

## 14. Backup

```bash
./deploy/scripts/backup.sh
# parts:
./deploy/scripts/backup-postgres.sh
./deploy/scripts/backup-uploads.sh
```

Behaviour:

- Postgres: `/var/backups/erpbuket1/erpbuket1_YYYYMMDDTHHMMSSZ.dump`
- Uploads volume: `/var/backups/erpbuket1/erpbuket1_uploads_YYYYMMDDTHHMMSSZ.tgz` (`erpbuket1_uploads_data` only)
- `umask 077`, dir `700`, files `600`
- Atomic write: `.partial` → `mv`
- Verifies non-empty + `PGDMP` / gzip magic
- Uses compose project / volumes `erpbuket1_*` only (never shop)
- **Auto-delete is OFF by default**
- Deploy never auto-restores DB after a failed migration

Documented retention: keep **14–30 days** of dumps locally; prune only after
confirming several recent successful dumps exist:

```bash
PRUNE_BACKUPS=1 CONFIRM_BACKUP_PRUNE=YES RETENTION_DAYS=14 MIN_KEEP_SUCCESSFUL=3 \
  ./deploy/scripts/backup.sh
```

Failed deploy does **not** delete backups.

### Off-site copies

Copy dumps to another server or encrypted storage (scp/rsync/USB).
**Do not** use the shop’s S3/object storage without a separate agreement.

Cron example (operator-owned):

```cron
15 2 * * * cd /opt/erpbuket1 && ./deploy/scripts/backup.sh >> /var/log/erpbuket1-backup.log 2>&1
```

---

## 15. Restore

Never automatic on deploy. Prefer restore into a **disposable** database first.

```bash
# Create test DB inside ERP postgres (not shop):
ERP_ENV_FILE=/etc/erpbuket1/production.env \
  docker compose --env-file "$ERP_ENV_FILE" -f docker-compose.prod.yml --project-name erpbuket1 \
    exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" flower_crm_restore_test || true'

TARGET_DB=flower_crm_restore_test CONFIRM_RESTORE=YES \
  ./deploy/scripts/restore-postgres.sh /var/backups/erpbuket1/erpbuket1_YYYYMMDDTHHMMSSZ.dump
```

Production overwrite (incident only — takes a safety backup first):

```bash
TARGET_DB=flower_crm CONFIRM_RESTORE=YES \
CONFIRM_PRODUCTION_RESTORE=YES I_UNDERSTAND_DESTRUCTIVE_RESTORE=YES \
  ./deploy/scripts/restore-postgres.sh /var/backups/erpbuket1/erpbuket1_YYYYMMDDTHHMMSSZ.dump
```

Guards: SQL identifier validation, refuse shop-like names, refuse lost-volume state,
require dump `PGDMP` magic.

---

## 16. Rollback (application images)

Rolls back **container images** built from an older git revision. Does **not**
downgrade PostgreSQL / Prisma. Primary checkout stays on its branch (temporary
**git worktree**; no `git reset --hard`, no detached HEAD on `/opt/erpbuket1`).

```bash
CONFIRM_ROLLBACK=YES ROLLBACK_TO=<git-sha-or-tag> ./deploy/scripts/rollback.sh
```

Behaviour:

1. Optional dirty-tree check on the primary tree
2. Backup of existing DB
3. **Prisma compatibility:** compares `_prisma_migrations` in live DB to migration
   dirs present in `ROLLBACK_TO`. If the DB has migrations absent from that
   revision → **fail closed** unless you explicitly accept risk:
   `CONFIRM_ROLLBACK_WITH_NEWER_SCHEMA=YES` (schema still not downgraded)
4. `git worktree add` → build/up api+web from that tree → remove worktree
5. Internal healthcheck (HTTP only — **not** sole proof of compatibility)
6. Primary `git` HEAD/branch unchanged

**Next normal update:** `git pull && ./deploy/scripts/deploy.sh` (forward path).

**Prefer a forward-fix release** over rolling back past applied migrations.
If the app misbehaves after image rollback: restore a matching dump or deploy a fix forward.

---

## 17. Diagnostics and failure stages

```bash
./deploy/scripts/status.sh
./deploy/scripts/healthcheck.sh --mode=internal
./deploy/scripts/healthcheck.sh --mode=public   # after HTTPS
# latest deploy log (no secrets if env file not sourced):
ls -lt /var/log/erpbuket1/deploy-*.log | head

ERP_ENV_FILE=/etc/erpbuket1/production.env \
  docker compose --env-file "$ERP_ENV_FILE" -f docker-compose.prod.yml --project-name erpbuket1 logs -f api web
```

| Stage / symptom           | What to do                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git error (fetch/ff-only) | Fix network/auth or diverged commits; shop untouched; retry `./deploy.sh`                                                                                                      |
| Build error               | Old api/web still running; fix code/deps; retry; no migrate yet if build failed before migrate                                                                                 |
| Backup error              | Deploy aborted before migrate; fix postgres/uploads; dumps kept                                                                                                                |
| Migration error           | API/Web **not** switched to new migrate outcome mid-flight; **no auto DB restore**; inspect dump in `/var/backups/erpbuket1`; restore only with explicit `restore-postgres.sh` |
| API/Web won't start       | `compose logs api                                                                                                                                                              | web`(project`erpbuket1` only); volumes intact |
| Health-check fail         | Do not assume success; check logs; optional image rollback via `rollback.sh` **only if schema compatible**                                                                     |
| After migrate + bad app   | Prefer **forward fix** release; image rollback does not downgrade Prisma schema                                                                                                |

| Symptom                     | Likely cause                                             |
| --------------------------- | -------------------------------------------------------- |
| Port in use                 | Another process / shop; change `ERP_*_PORT` or free port |
| migrate fail                | Fix SQL/migration; no auto DB rollback                   |
| healthcheck fail            | Inspect logs; do not assume success                      |
| public HTTPS fail           | DNS, Nginx, or cert missing                              |
| cookie/login fail over HTTP | Production cookies are Secure — need HTTPS               |

---

## 18. After VPS reboot

Docker `restart: unless-stopped` should bring ERP containers back. Verify:

```bash
./deploy/scripts/status.sh
./deploy/scripts/healthcheck.sh --mode=internal
# if public TLS was configured:
./deploy/scripts/healthcheck.sh --mode=public
```

Host Nginx/Certbot are systemd services — ensure they are enabled.

---

## 19. Check the shop before and after ERP work

Before and after install/deploy/nginx:

```bash
# Shop compose project name may differ — use whatever is already on the VPS
docker compose ls
# Hit the shop’s public URL in a browser or curl (operator knows the shop domain)
```

ERP scripts must not stop shop containers. If the shop breaks after an ERP Nginx
reload, restore **only** `/etc/nginx/sites-available/erpbuket1.conf` from its
`.bak.*` file (install-nginx keeps backups) and `nginx -t && systemctl reload nginx`.
Do not edit shop vhost files from ERP docs/scripts.

---

## 20. Three different operations (do not mix)

| Mode                       | Goal                           | Entry                                                    |
| -------------------------- | ------------------------------ | -------------------------------------------------------- |
| **Fresh install**          | Empty new ERP on HostFly       | `install.sh` with no prior marker/containers/volume      |
| **Migration from old ERP** | Bring data from another server | Install empty stack **first**, then restore dump (below) |
| **Disaster recovery**      | Volume lost on **this** VPS    | Manual recovery — **not** `install.sh`                   |

Dump files under `/var/backups/erpbuket1/` are **not** treated as proof that a
volume was lost. Nginx ERP vhost alone is **not** proof that a DB existed.

### State machine (summary)

| State                          | Meaning                                                          | Automations                                                                |
| ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `fresh`                        | No env, no volume, no host install evidence                      | `install.sh` may create env + empty volume                                 |
| `interrupted_first_install`    | Env only; no volume; no marker/containers                        | Needs `CONFIRM_CREATE_EMPTY_DB=YES` to finish                              |
| `existing`                     | Env + volume **proven** (compose volume label and/or marker)     | `deploy.sh` with backup→migrate                                            |
| `volume_unproven`              | Env + volume name exists, **no** project label and **no** marker | Stop; after `docker volume inspect`, only `CONFIRM_VOLUME_IS_ERP_DATA=YES` |
| `ambiguous_volume_without_env` | Volume without env                                               | Stop — restore env                                                         |
| `lost_volume`                  | Volume missing **and** marker and/or erpbuket1 containers exist  | **Hard stop** — `CONFIRM_CREATE_EMPTY_DB` cannot bypass                    |

### Migration from an old ERP server (safe order)

Do **not** start by running migrations against a new empty DB and hoping dumps
appear later. Choose one strategy and stick to it.

**Recommended:**

1. On the **old** server: `./deploy/scripts/backup.sh` → copy `erpbuket1_*.dump` off-box.
2. On HostFly: **fresh install** (`install.sh`) so env + labeled volume + schema exist.
   - You may place dumps in `/var/backups/erpbuket1/` **before or after** install;
     dumps alone do not block install.
3. **Do not** treat this empty DB as production data yet.
4. Restore dump into a **test** database first:
   ```bash
   TARGET_DB=flower_crm_restore_test CONFIRM_RESTORE=YES \
     ./deploy/scripts/restore-postgres.sh /var/backups/erpbuket1/erpbuket1_....dump
   ```
5. Validate row counts / login against the test DB (manual SQL / app pointing is operator-owned).
6. Production restore (destructive) only with dual confirmation — script takes a safety backup first:
   ```bash
   TARGET_DB=flower_crm CONFIRM_RESTORE=YES \
   CONFIRM_PRODUCTION_RESTORE=YES I_UNDERSTAND_DESTRUCTIVE_RESTORE=YES \
     ./deploy/scripts/restore-postgres.sh /var/backups/erpbuket1/erpbuket1_....dump
   ```
7. Then `./deploy/scripts/deploy.sh` so Prisma can **migrate forward** if the dump is older than the code.
8. Bootstrap DIRECTOR only if the restored data has no usable admin.

Never restore into shopbuket1’s PostgreSQL. ERP restore uses compose project `erpbuket1` only.

---

## Disaster recovery (lost volume on this VPS)

**Symptoms:** `install.marker` and/or `erpbuket1` compose containers exist, but
Docker volume `erpbuket1_postgres_data` is gone. State: `lost_volume`.

**Scripts refuse to create a new empty database.**
`CONFIRM_CREATE_EMPTY_DB=YES` **cannot** bypass this.
**Do not** run `install.sh` / `deploy.sh` as a recovery tool.

### Manual procedure

1. Stop automated install/deploy attempts. Run `./deploy/scripts/status.sh`.
2. Search for recoverable data:
   - `docker volume ls | grep erpbuket1`
   - off-site / local `erpbuket1_*.dump`
   - (advanced) Docker volume filesystem leftovers — only with full awareness
3. If a **dump** exists and `production.env` is intact:
   - Accept that anything not in the dump is lost.
   - Manually create an empty ERP volume **without** pretending install “fixed” it:
     ```bash
     ERP_ENV_FILE=/etc/erpbuket1/production.env
     docker compose --env-file "$ERP_ENV_FILE" -f docker-compose.prod.yml \
       --project-name erpbuket1 up -d postgres
     ```
   - Wait for healthy postgres, then restore (test DB first, then production confirms).
   - Run `./deploy/scripts/deploy.sh` only after restore to apply forward migrations if needed.
   - Recreate marker via a successful deploy/health path (or re-run deploy after restore).
4. If **no** dump and no volume backup: data is unrecoverable from ERP tooling.
   Green-field reinstall is a **business decision**: remove install marker and ERP
   containers only after explicit approval, then `fresh` install. Not scripted.
5. Never: `down -v`, `volume prune`, `system prune`, or shop volume operations.

`CONFIRM_CREATE_EMPTY_DB=YES` applies **only** to `interrupted_first_install`
(env present, volume missing, **no** marker and **no** erpbuket1 containers).

`CONFIRM_VOLUME_IS_ERP_DATA=YES` applies **only** to `volume_unproven` after you
inspected `docker volume inspect erpbuket1_postgres_data` and confirmed labels/data.

---

## Security checklist

- Secrets only in `/etc/erpbuket1/production.env` (600); never in Git
- Scripts read env via `--env-file` / key getters — **no** `source`/`eval` of secrets
- Postgres not published on host
- API/Web on loopback only; public via Nginx TLS
- `TRUST_PROXY=1`, Secure cookies in production
- Backup dir 700 / dumps 600
- Parallel ops serialized with flock (`/var/lock/erpbuket1-ops.lock`)

---

## Script index

| Script                                      | Purpose                                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `deploy/scripts/install.sh`                 | First install / handoff to deploy                         |
| `deploy/scripts/deploy.sh`                  | Update (backup → build → migrate → up)                    |
| `deploy/scripts/healthcheck.sh`             | `--mode=internal` \| `public`                             |
| `deploy/scripts/status.sh`                  | Read-only status                                          |
| `deploy/scripts/backup.sh`                  | Backup entrypoint                                         |
| `deploy/scripts/backup-postgres.sh`         | Backup implementation                                     |
| `deploy/scripts/restore-postgres.sh`        | Confirmed restore                                         |
| `deploy/scripts/rollback.sh`                | App image rollback via git worktree (no schema downgrade) |
| `deploy/scripts/install-nginx.sh`           | ERP Nginx vhost only                                      |
| `deploy/scripts/issue-cert.sh`              | Let’s Encrypt webroot for ERP_DOMAIN                      |
| `deploy/scripts/bootstrap-initial-users.sh` | First DIRECTOR                                            |
| `deploy/scripts/reset-user-password.sh`     | Password reset (confirmed)                                |

Legacy reference file `deploy/nginx/erp.nasytko.ru.conf` is **not** used by
current HostFly scripts — use `erpbuket1.conf.template` /
`erpbuket1.ssl.conf.template` via `install-nginx.sh`.

---

## Forbidden operations

```bash
# NEVER on production ERP:
docker compose ... down -v
docker volume rm erpbuket1_postgres_data
docker volume prune
docker system prune
git reset --hard          # not used by ERP scripts
certbot --nginx           # use issue-cert.sh webroot instead
```

Do not edit shopbuket1 project files from this repository’s runbooks.
