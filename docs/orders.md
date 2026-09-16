# Orders

Commercial order documents with daily Kanban, stock reservations, and FIFO COGS on completion.

## Aggregate

- `Order` — commercial header (number, status, fulfillment, customer/recipient snapshot, totals, `version`, `actualCost`, `hasUncostedConsumption`)
- `OrderItem` — PRODUCT or BOUQUET line with price snapshot
- `OrderItemComponent` — frozen bouquet composition (`quantityPerItem`, `totalQuantity`) used for reservation requirements
- `StockReservation` — per-order per-product `requiredQuantity` / `reservedQuantity` (mutable while NEW/READY)
- `OrderDailyCounter` — internal per-day sequence (not exposed via API)

## Numbering

Format: `DDMMYY-NNN` (e.g. `150926-001`).

- Based on **creation** business calendar day in `BUSINESS_TIME_ZONE` (default `Europe/Minsk`), not fulfillment date.
- Allocated with `INSERT … ON CONFLICT DO UPDATE RETURNING lastNumber` inside the create transaction.
- `Order.id` remains CUID; `number` is unique business identifier only.

## Status machine

```
NEW → READY → COMPLETED
NEW → CANCELLED
READY → CANCELLED
READY → NEW
```

COMPLETED and CANCELLED are terminal.

UI labels for READY/COMPLETED depend on PICKUP vs DELIVERY (`orderStatusLabelRu`).

`POST /orders/:id/status` with `{ status, expectedVersion }`. Cancel also requires `orders.cancel`.

### Phase 8 status rules

| Transition            | Stock / reservation effect                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Create / update (NEW) | Reconcile reservations from snapshot FLOWER requirements; allocate available without preemption |
| NEW → READY           | **Blocked** if any product has `reserved < required` (`ORDER_HAS_SHORTAGE`)                     |
| READY → COMPLETED     | Same shortage check; then FIFO consume reserved qty → `SALE` movements + COGS                   |
| → CANCELLED           | Release all reservations; reallocate freed stock to other active shortages by priority          |
| READY → NEW           | Reservations kept; shortage may still exist                                                     |

UI (Kanban + detail) also blocks Ready/Complete client-side when `hasShortage`.

## Phase 8 — reservations & priority

Requirements come from the **order snapshot** (product FLOWER lines + bouquet component totals), not live bouquet recipes.

**Priority** (only when allocating _new or released_ available stock):

1. Earlier `fulfillmentDate`
2. Timed orders before no-time
3. Earlier `fulfillmentTimeFrom`
4. Earlier `createdAt`
5. `number`

**No preemption:** an existing reservation is never stolen by a newer higher-priority order. Shortage on an earlier order does not reduce another order’s reserved qty.

On **supply post** (and inventory surplus / cancel release), available stock is allocated to shortage reservations in priority order.

See [reservations.md](./reservations.md) for lock order and invariants.

## Phase 8 — completion (FIFO SALE / COGS)

On COMPLETED:

1. Assert no shortage
2. Warehouse advisory lock + `ProductStock` locks
3. For each reservation with `reservedQuantity > 0`: FIFO consume lots → `StockMovement` type `SALE` + lot allocations; decrease `quantityOnHand` and `quantityReserved`
4. Delete reservation rows
5. Set `actualCost` (sum of known lot costs) or leave null if any uncosted consumption; set `hasUncostedConsumption`
6. Detail API exposes `grossProfit = total − actualCost` when caller has `purchase_price.view` and cost is complete

## Inventory freeze

While any inventory session is `IN_PROGRESS`, physical stock mutations (supply post, write-off, order COMPLETED consumption, etc.) fail with `INVENTORY_IN_PROGRESS` via `WarehouseLockService.beginStockMutation`.

Write-off may only use **available** stock (`onHand − reserved`); reserved qty is protected (`INSUFFICIENT_STOCK`).

## Fulfillment

|           | PICKUP                        | DELIVERY                |
| --------- | ----------------------------- | ----------------------- |
| Address   | cleared / null                | required                |
| Recipient | unused (effective = customer) | optional; else customer |
| Time      | optional `HH:mm`              | optional from–to        |

Times are **local wall-clock strings** (`VARCHAR(5)`), not UTC timestamps.

## Snapshot rules

Adding a Bouquet copies current `BouquetItem` rows into `OrderItemComponent`. Later bouquet/product renames or recipe/price changes do **not** alter historical orders or their reservation requirements.

## Pricing

Backend-authoritative Decimal (`12,2`):

- `lineSubtotal = qty × unitPrice`
- `subtotal = Σ lineSubtotal`
- discount PERCENT (0–100) or FIXED (≤ subtotal) — reject invalid
- `total = subtotal − discountAmount`

`orders.discount` required for discount or unit price override.

## Concurrency

Atomic CAS: `UPDATE … WHERE id AND version = expectedVersion` (same pattern as Bouquet), then replace items / change status. Conflict → `409 ORDER_CONFLICT`.

Reservation mutations run under the warehouse advisory lock with `ProductStock FOR UPDATE` sorted by `productId`.

## API

- `GET /api/v1/orders/business-time`
- `GET /api/v1/orders?date=YYYY-MM-DD&fulfillmentType&status&timeFrom&timeTo&withoutTime&search&includeCancelled` — `date` optional when `search` (≥2 chars) is provided (cross-day lookup)
- `GET /api/v1/orders/:id` — includes `requirements[]`, `hasShortage`, `shortageProductCount`; cost fields when permitted
- `POST /api/v1/orders`
- `PATCH /api/v1/orders/:id`
- `POST /api/v1/orders/:id/status`

List sort: timed orders ascending by `fulfillmentTimeFrom`, **no-time last**, then `number`.

## Permissions

|                           | Florist | Manager | Director |
| ------------------------- | ------- | ------- | -------- |
| view/create/update/status | ✓       | ✓       | ✓        |
| cancel                    |         | ✓       | ✓        |
| discount / price override |         | ✓       | ✓        |
| purchase price / COGS     |         | ✓       | ✓        |

## UI

`/app/orders?date=` — daily Kanban (NEW / READY / COMPLETED). Shortage badge «Не хватает · N». Drag changes status via API (client + server block Ready/Complete on shortage). Create: `/app/orders/new?date=`. Detail: section «Обеспеченность»; cancel confirms reservation release.
