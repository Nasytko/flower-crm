# Database

Phase 1 подключает PostgreSQL и Prisma. Phase 3 добавляет складское ядро: `Product`, `ProductStock`, `StockMovement`. Подробности — в `docs/inventory.md`.

## PostgreSQL

Локально PostgreSQL 17 запускается контейнером `postgres` из корневого `docker-compose.yml`.

- Named volume `flower_crm_postgres_data` сохраняет данные между перезапусками.
- Healthcheck использует `pg_isready`.
- Учётные данные задаются через `.env` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`).
- Приложение подключается по `DATABASE_URL`.

Frontend и API в Docker на этом этапе не упаковываются.

## Prisma

Prisma живёт в пакете `packages/database`.

- Schema: `packages/database/prisma/schema.prisma`
- Конфиг CLI: `packages/database/prisma.config.ts`
- Client генерируется в `packages/database/src/generated/client`
- NestJS получает клиент через `createPrismaAdapter` / `PrismaService`

Схема Phase 2:

- `User` (`users`)
- `Session` (`sessions`)
- `AuditLog` (`audit_logs`)
- enum `Role`

Схема Phase 3 (warehouse core):

- enums `ProductType`, `Unit`, `StockMovementType`
- `Product` (`products`) — номенклатура; деньги `DECIMAL(12,2)`
- `ProductStock` (`product_stocks`) — snapshot только для FLOWER; CHECK: onHand≥0, reserved≥0, reserved≤onHand
- `StockMovement` (`stock_movements`) — append-only ledger; signed `quantity`; `balanceAfter`; CHECK: quantity≠0, balanceAfter≥0

Permissions хранятся в коде (`packages/shared`), не в БД.

## Migration strategy

Источник истины по схеме — Prisma Migrate, не ручные правки live-базы и не `db push`.

Рабочий цикл изменения схемы:

1. Изменить `schema.prisma`.
2. Создать миграцию: `pnpm db:migrate` (`prisma migrate dev`).
3. Проверить сгенерированный SQL.
4. Закоммитить `schema.prisma` и файлы в `prisma/migrations`.
5. На других машинах / в будущем deploy применять `pnpm db:migrate:deploy`.

Phase 1: `20260914100000_init` (bootstrap).
Phase 2: `20260914120000_auth_foundation` (`User` / `Session` / `AuditLog`).
Phase 2 follow-up: `20260914190000_session_previous_token_hash`.
Phase 3: `20260914200000_warehouse_core` (`Product` / `ProductStock` / `StockMovement` + CHECKs).
Phase 4: `20260914210000_supplies_lots` (`Supply` / `SupplyItem` / `StockLot` / allocations).
Phase 5: `20260914220000_inventory_stocktake` (`InventorySession` / `InventoryItem`, nullable lot cost, `StockLotSource`).
Phase 6: `20260914230000_bouquets` (`Bouquet` / `BouquetItem`, optimistic `version`).

Складские транзакции сериализуются через `pg_advisory_xact_lock(482910374651)` + row locks. См. `docs/inventory.md`. Букеты склад не меняют.

- Не редактировать уже применённые migration files, если они могли уйти в shared history.
- Не коммитить схему без соответствующей миграции.
- Не добавлять модели «на будущее». Таблица появляется вместе с доменным модулем, которому она нужна.
- Не экспортировать Prisma models во frontend. Для UI нужен API DTO / shared contract.
- `DATABASE_URL` и другие секреты не логировать.

## Почему не `db push` как production strategy

`prisma db push` удобен для прототипа: он синхронизирует schema без истории. Для этой системы это неприемлемо как постоянный путь:

- нет воспроизводимого audit trail схемы;
- сложнее откатывать изменения;
- окружения начинают расходиться.

`db push` допустим только как осознанный локальный эксперимент, который не заменяет миграцию перед коммитом.

## Транзакции

Межтабличные бизнес-изменения выполняются только внутри `prisma.$transaction`.

Phase 3 stock adjustment:

1. `SELECT ... FROM product_stocks ... FOR UPDATE`
2. validate next quantity
3. update snapshot + insert ledger + audit
4. commit

См. `docs/inventory.md` и `docs/supplies.md`. Inventory / Orders используют тот же паттерн с `StockMovementType`.
