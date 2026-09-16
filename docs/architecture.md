# Архитектура

Modular monolith внутренней CRM/ERP для цветочного магазина. Phases **1–8** реализованы; **Phase 9** — hardening (UX, invalidation, live e2e, docs). Платежи / CRM / public storefront API сознательно отложены.

## Почему modular monolith

Систему будут ежедневно использовать сотрудники одного магазина. На старте это одна команда, одна база данных и один deployable backend.

Modular monolith даёт:

- простые транзакции PostgreSQL между доменами;
- один процесс NestJS и один способ логирования/конфигурации;
- возможность выделять domain modules без распределённой инфраструктуры.

Microservices, очереди, Redis, CQRS и event sourcing сознательно отложены.

## Почему frontend и backend разделены

Next.js и NestJS — разные приложения в monorepo.

- Сотрудники работают в веб-интерфейсе `apps/web`.
- NestJS в `apps/api` владеет бизнес-логикой, данными и будущим публичным API.
- Интернет-магазин не должен ходить в Next.js, чтобы создать заказ. Он будет вызывать REST API.

Поэтому API запускается независимо от frontend и не импортирует UI-код.

## Роль Next.js

Next.js — внутренний UI на App Router.

- Auth shell, сотрудники
- Склад (`/app/warehouse`) — on hand / reserved / available
- Поставки, инвентаризация, букеты-рецепты
- Заказы — Kanban по business-date, редактор, статусы
- TanStack Query + `invalidateStockViews` после складских мутаций
- Коды ошибок API → RU через `userFacingError`

Next.js не является источником истины по правам доступа: UI permissions только для UX.

## Роль NestJS

NestJS — единственное место бизнес-логики и authorization.

Модули:

- `health`, `prisma`, `auth`, `employees`, `audit`
- `products` — Product / ProductStock / StockMovement
- `supplies` — Supply / SupplyItem / StockLot
- `inventories` — InventorySession / InventoryItem + warehouse freeze
- `bouquets` — Bouquet / BouquetItem (recipe, not stock)
- `orders` — Order / OrderItem / OrderItemComponent + completion SALE/COGS
- `warehouse` — advisory lock, freeze guard, FIFO, reservation allocation

Публичный контракт версионируется префиксом `/api/v1`.

Бизнес-потоки кратко: [`business-workflows.md`](./business-workflows.md).

## Роль PostgreSQL / Prisma

PostgreSQL — система записи. Prisma в `packages/database` — schema, migrations, client. Prisma models не экспортируются во frontend как API-контракт.

Local Postgres — Docker Compose; Node-процессы на хосте.

## Структура monorepo

```text
apps/web           UI
apps/api           REST API
packages/database  Prisma
packages/shared    общие типы контракта API
docs               документация доменов
```

## Будущий public API / deploy

Публичный контур магазина и reverse-proxy deploy можно добавить без смены архитектуры. Сейчас backend уже независим от frontend.

Ожидаемый контур позже: `Git → VPS → Docker Compose → web + api + postgres`.
