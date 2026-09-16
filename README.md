# Flower CRM / ERP

Внутренняя CRM/ERP-система для цветочного магазина.

Сейчас в репозитории:

- **Phase 1** — технический фундамент
- **Phase 2** — auth / employees / audit
- **Phase 3** — products + warehouse core
- **Phase 4** — supplies + stock lots + FIFO write-off
- **Phase 5** — inventory / stocktake (snapshot → count → ledger adjustments)
- **Phase 6** — bouquets as recipes (no stock)
- **Phase 7** — orders (Kanban, numbering, commercial statuses)
- **Phase 8** — reservations / shortages / completion COGS
- **Phase 9** — hardening (UX polish, cross-module invalidation, live e2e, docs)

Платежи, CRM и публичный API сайта — вне текущего контура. Документы: [`docs/architecture.md`](docs/architecture.md), [`docs/business-workflows.md`](docs/business-workflows.md), [`docs/orders.md`](docs/orders.md), [`docs/reservations.md`](docs/reservations.md), [`docs/bouquets.md`](docs/bouquets.md), [`docs/inventory.md`](docs/inventory.md), [`docs/supplies.md`](docs/supplies.md), [`docs/deployment.md`](docs/deployment.md).

## Стек

| Слой        | Технологии                                             |
| ----------- | ------------------------------------------------------ |
| Frontend    | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui    |
| Backend     | NestJS, REST, Swagger/OpenAPI                          |
| Database    | PostgreSQL, Prisma ORM                                 |
| Monorepo    | pnpm workspaces, Turborepo                             |
| Local infra | Docker Compose (dev: Postgres; prod: web+api+Postgres) |
| CI          | GitHub Actions                                         |

Backend — самостоятельное приложение. Frontend не нужен для запуска API. В будущем интернет-магазин сможет отправлять заказы в CRM через API, не используя Next.js.

## Структура monorepo

```text
apps/web              Next.js UI
apps/api              NestJS REST API
packages/database     Prisma schema, migrations, Prisma Client
packages/shared       общие API-контракты (health, roles, permissions, auth types)
docs                  архитектурная документация
```

Пакет `packages/config` не создан: на текущем этапе он не даёт пользы. Общие TypeScript/Prettier правила лежат в корне репозитория.

## Prerequisites

- Node.js 22.12+
- pnpm 10+
- Docker Desktop / Docker Engine с Docker Compose — обязателен для локального PostgreSQL
- Git

Node и pnpm ставятся локально. Frontend и backend в Docker на этом этапе не запускаются.

Без запущенного PostgreSQL API всё равно стартует: `GET /api/v1/health` вернёт HTTP `503` со статусом `degraded`. Для полного local setup нужен `docker compose up -d postgres`.

## Установка

```bash
git clone <repository-url>
cd ERP
cp .env.example .env
pnpm install
```

`pnpm install` также сгенерирует Prisma Client (`postinstall`).

## Настройка .env

В корне репозитория один `.env` на весь monorepo.

```bash
cp .env.example .env
```

Для локальной разработки значения из `.env.example` можно оставить как есть:

| Переменная                                              | Назначение                                 |
| ------------------------------------------------------- | ------------------------------------------ |
| `NODE_ENV`                                              | `development`, `test` или `production`     |
| `API_PORT`                                              | порт NestJS, по умолчанию `3001`           |
| `WEB_URL`                                               | origin frontend; используется для CORS     |
| `NEXT_PUBLIC_API_URL`                                   | публичный URL API для браузера             |
| `POSTGRES_*`                                            | параметры контейнера PostgreSQL            |
| `DATABASE_URL`                                          | строка подключения Prisma/NestJS           |
| `JWT_ACCESS_SECRET`                                     | секрет подписи access JWT (>= 32 символов) |
| `JWT_ACCESS_TTL_SECONDS`                                | TTL access token (по умолчанию 900)        |
| `SESSION_TTL_SECONDS`                                   | TTL refresh session (по умолчанию 14 дней) |
| `AUTH_COOKIE_NAME`                                      | имя HttpOnly refresh cookie                |
| `AUTH_LOGIN_MAX_ATTEMPTS` / `AUTH_LOGIN_WINDOW_SECONDS` | rate limit login                           |
| `TRUST_PROXY`                                           | Express trust proxy hops (`false` default) |

`.env` не коммитится. Реальные секреты в `.env.example` не хранятся.

NestJS читает корневой `.env` через `ConfigModule`. Next.js читает из него только переменные `NEXT_PUBLIC_*` в `apps/web/next.config.ts`, чтобы `NODE_ENV=development` из `.env` не ломал production build. Prisma читает корневой `.env` в `packages/database/prisma.config.ts`.

## Запуск PostgreSQL

```bash
docker compose up -d postgres
```

Проверка:

```bash
docker compose ps
```

Данные PostgreSQL сохраняются в named volume `flower_crm_postgres_data`.

## Prisma migrations

После старта PostgreSQL примените миграции:

```bash
pnpm db:migrate:deploy
```

Для разработки новых миграций (последующие этапы):

```bash
pnpm db:migrate
```

Phase 1 содержит пустую initial migration.
Phase 2 добавляет migration `20260914120000_auth_foundation` с моделями `User`, `Session`, `AuditLog`.

Другие команды:

```bash
pnpm db:generate        # prisma generate
pnpm db:seed            # development users (director/manager/florist)
pnpm db:studio          # Prisma Studio
```

`prisma db push` не используем как постоянную стратегию миграций.

### Development seed

Только для local/dev:

| login      | role     | password       |
| ---------- | -------- | -------------- |
| `director` | DIRECTOR | `Director123!` |
| `manager`  | MANAGER  | `Manager123!`  |
| `florist`  | FLORIST  | `Florist123!`  |

**Development credentials only. Never use in production.**

```bash
pnpm db:seed
```

## Запуск проекта

Из корня репозитория:

```bash
pnpm dev
```

Turborepo запустит:

- frontend: [http://localhost:3000](http://localhost:3000)
- API: [http://localhost:3001](http://localhost:3001)

Отдельный запуск:

```bash
pnpm --filter @erp/api dev
pnpm --filter @erp/web dev
```

## Health endpoint

```bash
curl http://localhost:3001/api/v1/health
```

Успешный ответ:

```json
{
  "status": "ok",
  "database": "up"
}
```

Если PostgreSQL недоступна, API всё равно запускается и возвращает HTTP `503`:

```json
{
  "status": "degraded",
  "database": "down"
}
```

Стартовая страница frontend перенаправляет на `/login` или `/app`.

## Auth

Документация: [docs/auth.md](docs/auth.md), [docs/permissions.md](docs/permissions.md), [docs/audit.md](docs/audit.md).

Основные endpoints:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/employees`
- `GET /api/v1/audit`

UI:

- `/login`
- `/app`
- `/app/employees`

## Swagger

В non-production окружениях документация доступна по адресу:

[http://localhost:3001/api/v1/docs](http://localhost:3001/api/v1/docs)

В `production` Swagger не поднимается.

## Tests

```bash
pnpm test
```

Unit-тесты API используют mock Prisma и не требуют PostgreSQL.

Live concurrency / integration suites (`apps/api/test/*.concurrency.spec.ts`, `*.live.spec.ts`, в т.ч. `business-e2e.live.spec.ts` и `orders-completion-rollback.live.spec.ts`) **выполняются при наличии доступной БД** по `DATABASE_URL` (локально после `docker compose up -d postgres` + `pnpm db:migrate:deploy`, и в GitHub Actions CI с service container PostgreSQL 17).

Если БД недоступна, live-suite пропускают кейсы без падения всего прогона.

### Playwright (optional / NON-BLOCKING)

UI Playwright smoke **не подключён** в CI (хрупкий E2E без стабильного стенда). Приоритет — live API e2e. Долг: при необходимости добавить `apps/web` Playwright + один smoke, пропускаемый без `WEB_URL` / `E2E_BASE_URL`, без блокировки CI.

## Lint / Typecheck / Build

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## CI

Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

На `push` / `pull_request`:

1. `pnpm install --frozen-lockfile`
2. migrations (`pnpm db:migrate:deploy`) против PostgreSQL service
3. `pnpm lint` / `typecheck` / `test` / `build`
4. `pnpm audit --prod --audit-level=high` (non-blocking)

## Документация

- [Архитектура](docs/architecture.md)
- [Бизнес-потоки](docs/business-workflows.md)
- [База данных](docs/database.md)
- [Authentication](docs/auth.md)
- [Permissions](docs/permissions.md)
- [Audit](docs/audit.md)
- [Orders](docs/orders.md) / [Reservations](docs/reservations.md) / [Supplies](docs/supplies.md) / [Inventory](docs/inventory.md) / [Bouquets](docs/bouquets.md)
- [Production deployment](docs/deployment.md)

## Что ещё не реализовано

Платежи, CRM-клиенты, публичный каталог/API магазина, trusted devices, MFA, полноценный Playwright UI E2E. Production deploy на VPS — ручной (см. `docs/deployment.md`); CI/CD-автодеплой не настроен.
