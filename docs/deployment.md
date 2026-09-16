# Production deployment — NewERP (Flower CRM)

Domain: `https://erp.nasytko.ru`  
VPS path: `/opt/apps/newerp`  
Backups: `/opt/backups/postgres`  
Compose file: `docker-compose.prod.yml`

This document prepares a **manual** first deploy and updates on Ubuntu 24.04 with
**host Nginx** (not containerized). NewERP must not monopolize the VPS — a future
shop can share the host.

## Architecture

```text
Internet
   |
   v
Host Nginx :80/:443  (Certbot TLS)
   |
   +--> erp.nasytko.ru/
   |         -> 127.0.0.1:3000  (newerp-web / Next.js)
   |
   +--> erp.nasytko.ru/api/...
             -> 127.0.0.1:3001  (newerp-api / NestJS /api/v1)
                    |
                    v
             newerp-postgres (Docker network only, NO host port)
```

**External surface must be only:** `22`, `80`, `443`.  
**Must NOT be public:** `3000`, `3001`, `5432`.

Same-origin browser API URL (`NEXT_PUBLIC_API_URL=https://erp.nasytko.ru`) keeps
refresh cookies (`Path=/api/v1/auth`) on the ERP host.

## Prerequisites (VPS)

- Ubuntu 24.04 LTS
- Docker Engine + Compose plugin
- Git
- Nginx on the host
- UFW allowing 22/80/443 (managed manually)
- DNS `A`/`AAAA` for `erp.nasytko.ru` pointing at the VPS

```bash
sudo mkdir -p /opt/apps /opt/backups/postgres
sudo chown "$USER":"$USER" /opt/apps /opt/backups/postgres
```

## 1. Clone

```bash
cd /opt/apps
git clone https://github.com/Nasytko/flower-crm.git newerp
cd /opt/apps/newerp
```

## 2. Production `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` (minimum):

```bash
NODE_ENV=production
WEB_URL=https://erp.nasytko.ru
NEXT_PUBLIC_API_URL=https://erp.nasytko.ru
TRUST_PROXY=1
BUSINESS_TIME_ZONE=Europe/Minsk
POSTGRES_USER=newerp
POSTGRES_PASSWORD='PASTE_OPENSSL_SECRET'
POSTGRES_DB=flower_crm
JWT_ACCESS_SECRET='PASTE_OPENSSL_SECRET'
```

### Secret generation

```bash
openssl rand -base64 32   # POSTGRES_PASSWORD (prefer URL-safe / avoid @ : / ?)
openssl rand -base64 48   # JWT_ACCESS_SECRET
```

If `POSTGRES_PASSWORD` contains URL-reserved characters, URL-encode them inside
any manually built `DATABASE_URL`. Compose builds `DATABASE_URL` from
`POSTGRES_*` for containers.

**Never commit `.env`. Never bake `.env` into images.**

## 3. First deploy

```bash
cd /opt/apps/newerp
chmod +x deploy/scripts/*.sh

# Build + postgres + migrate + api/web (no backup on empty volume)
FIRST_DEPLOY=1 ./deploy/scripts/deploy.sh
```

Or step-by-step:

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml run --rm migrate   # MUST succeed
docker compose -f docker-compose.prod.yml up -d api web
docker compose -f docker-compose.prod.yml ps
curl -fsS http://127.0.0.1:3001/api/v1/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

### Initial users (explicit — not automatic)

Seed **refuses** `NODE_ENV=production` and is **not** run on container start.

```bash
# loads POSTGRES_* from .env via compose
set -a && source .env && set +a
CONFIRM_PRODUCTION_BOOTSTRAP=YES ./deploy/scripts/bootstrap-initial-users.sh
```

Default seeded logins (change password immediately):

| Login    | Password (dev default) |
| -------- | ---------------------- |
| director | Director123!           |
| manager  | Manager123!            |
| florist  | Florist123!            |

Emails: `director@flower.local`, etc.

## 4. Host Nginx

```bash
sudo cp /opt/apps/newerp/deploy/nginx/erp.nasytko.ru.conf \
  /etc/nginx/sites-available/erp.nasytko.ru.conf
sudo ln -sf /etc/nginx/sites-available/erp.nasytko.ru.conf \
  /etc/nginx/sites-enabled/erp.nasytko.ru.conf
sudo nginx -t && sudo systemctl reload nginx
```

Ensure DNS points to this VPS, then:

```bash
sudo certbot --nginx -d erp.nasytko.ru
```

Verify:

```bash
curl -fsS https://erp.nasytko.ru/api/v1/health
# Open https://erp.nasytko.ru/login and sign in
```

## 5. Backup + restore test

```bash
./deploy/scripts/backup-postgres.sh
ls -lah /opt/backups/postgres
```

**Test restore into a disposable DB** (never overwrite production silently):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'createdb -U "$POSTGRES_USER" flower_crm_restore_test || true'

TARGET_DB=flower_crm_restore_test CONFIRM_RESTORE=YES \
  ./deploy/scripts/restore-postgres.sh /opt/backups/postgres/newerp_YYYYMMDDTXXXXXXZ.dump
```

Drop the test DB when done:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" flower_crm_restore_test'
```

### Cron (root) — example daily 02:15

```cron
15 2 * * * cd /opt/apps/newerp && /opt/apps/newerp/deploy/scripts/backup-postgres.sh >> /var/log/newerp-backup.log 2>&1
```

Local retention default: **7 days**.  
**A backup only on this VPS is insufficient disaster recovery** — copy dumps off-box.

## 6. Reboot check

```bash
sudo reboot
# after reboot:
docker compose -f /opt/apps/newerp/docker-compose.prod.yml ps
curl -fsS http://127.0.0.1:3001/api/v1/health
sudo systemctl status nginx --no-pager
```

Containers use `restart: unless-stopped`. Enable Docker on boot if needed:

```bash
sudo systemctl enable docker
```

---

## Normal update

```bash
cd /opt/apps/newerp
git fetch origin
git checkout main
git pull --ff-only origin main

./deploy/scripts/deploy.sh
# (backs up → build → migrate deploy → up → health)
```

Manual equivalent:

```bash
./deploy/scripts/backup-postgres.sh
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d api web
curl -fsS http://127.0.0.1:3001/api/v1/health
```

### If something fails

| Failure         | Action                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Build fails     | Fix code/deps; do **not** migrate yet                                                                                  |
| Migration fails | Deploy stops; app keeps previous containers if you did not recreate them — investigate migration; **do not** `db push` |
| API unhealthy   | `docker compose -f docker-compose.prod.yml logs --tail=200 api`                                                        |
| Web unhealthy   | `docker compose -f docker-compose.prod.yml logs --tail=200 web`                                                        |
| DB unhealthy    | `docker compose -f docker-compose.prod.yml logs --tail=200 postgres`                                                   |
| Disk full       | `df -h`; `docker system df`; remove old **images** carefully; **never** prune volumes                                  |

---

## Rollback

### Application

```bash
git log --oneline -10
git checkout <previous-good-sha>
./deploy/scripts/deploy.sh
```

Rebuild/redeploy that commit. If a **new Prisma migration** already ran, older app code may be incompatible.

### Database

- Prisma migrations are **forward-only**.
- Rolling back the app **does not** roll back schema.
- Restore from `pg_dump` only as a deliberate incident procedure (`CONFIRM_RESTORE=YES`).

---

## Dangerous commands

```bash
# SAFE: stops containers, KEEPS postgres volume
docker compose -f docker-compose.prod.yml down

# DESTROYS DATABASE VOLUME — never use in normal ops
docker compose -f docker-compose.prod.yml down -v
```

---

## Logging

```bash
docker compose -f docker-compose.prod.yml logs --tail=200 api
docker compose -f docker-compose.prod.yml logs -f web
```

JSON-file log rotation is configured in Compose (`max-size=10m`, `max-file=5`).

API logs go to stdout via Pino (no secrets: auth headers/cookies redacted).

---

## Disk

```bash
df -h
docker system df
```

Safe-ish image cleanup (does **not** remove named volumes):

```bash
docker image prune
```

**Never** run `docker volume prune` on production without understanding it can delete unused volumes — the Postgres data volume must never be casually deleted.

---

## Health endpoints

| URL                       | Meaning                                        |
| ------------------------- | ---------------------------------------------- |
| `GET /api/v1/health/live` | Process up (no DB)                             |
| `GET /api/v1/health`      | Readiness: API + PostgreSQL (`503` if DB down) |

Docker API healthcheck uses `/api/v1/health`.

---

## Security checklist

- Postgres: no host port; not on Internet
- Web/API: bound to `127.0.0.1` only
- Swagger: disabled when `NODE_ENV=production`
- Cookies: `Secure` in production; HTTPS required
- `WEB_URL` / OriginGuard / CORS: `https://erp.nasytko.ru`
- `TRUST_PROXY=1` for one Nginx hop (client IP / audit / throttle)
- Seed not auto-run
- Migrations: `prisma migrate deploy` only (never `migrate dev` / `db push` in prod)

---

## Coexistence with a future shop

NewERP uses host ports `3000`/`3001` on loopback and Nginx server_name
`erp.nasytko.ru` only. A shop can use other loopback ports and another
`server_name` on the same Nginx without sharing NewERP containers or DB.
