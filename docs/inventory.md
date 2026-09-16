# Inventory / Stocktake (Phase 5)

Physical stocktake for the flower shop CRM. Inventory is a **business document**. It never silently overwrites `ProductStock`.

## Lifecycle

```
DRAFT → IN_PROGRESS → COMPLETED
                  ↘ CANCELLED
DRAFT → CANCELLED
```

| Status        | Meaning                                      |
| ------------- | -------------------------------------------- |
| `DRAFT`       | Created; snapshot not taken                  |
| `IN_PROGRESS` | Expected quantities frozen; counting allowed |
| `COMPLETED`   | Immutable; stock adjusted via ledger         |
| `CANCELLED`   | History only; **no** stock changes           |

Human-readable number: `INV-000001` via PostgreSQL sequence `inventory_number_seq` (not `MAX+1`).

Only **one** `IN_PROGRESS` session may exist (partial unique index + advisory lock). Prefer also only one open DRAFT/IN_PROGRESS for UX.

## Snapshot semantics

On **start** (or `start-new`):

1. Acquire warehouse advisory lock
2. Select FLOWER products where `isActive` **OR** `quantityOnHand > 0` **OR** `quantityReserved > 0`
3. **SERVICE never included**
4. Create `InventoryItem` with `expectedQuantity = ProductStock.quantityOnHand`
5. Mark `IN_PROGRESS`

`expectedQuantity` is **frozen**. It is not recalculated from live stock during counting.

`countedQuantity` is **nullable**: `null` = not counted yet; `0` = physically empty. Do not use `0` as “empty input”.

## Warehouse freeze

While any inventory is `IN_PROGRESS`, physical stock mutations are forbidden:

- supply post
- supply reverse / correction post
- write-off

Domain error: `INVENTORY_IN_PROGRESS`.

Draft supply create/edit remains allowed (does not change stock).

Central guard: `WarehouseLockService.beginStockMutation(tx)`.

## Concurrency strategy

Lock key: `pg_advisory_xact_lock(482910374651)` — transaction-scoped, not session lock.

**Lock order (deadlock-safe):**

1. Warehouse advisory xact lock
2. Business document row (`FOR UPDATE`)
3. `ProductStock` rows sorted by `productId`
4. `StockLot` rows FIFO (`receivedAt`, `createdAt`, `id`)

Used on: inventory start/complete/cancel (lock), supply post/reverse, write-off.

## Completion

`POST /inventories/:id/complete`:

1. Lock session; require `IN_PROGRESS`
2. Reject if any `countedQuantity` is null → `INVENTORY_INCOMPLETE`
3. Lock stocks; verify `quantityOnHand === expectedQuantity` → else `INVENTORY_STOCK_CHANGED`
4. Reject if `counted < quantityReserved` → `INVENTORY_BELOW_RESERVED`
5. For each difference ≠ 0:
   - **Negative:** FIFO consume lots + `StockMovementLotAllocation` + movement `INVENTORY_ADJUSTMENT` (negative qty)
   - **Positive:** create **uncosted** `StockLot` (`sourceType=INVENTORY`, `unitPurchasePrice=null`, linked `inventoryItemId`) + positive movement
   - **Zero:** no movement
6. Mark `COMPLETED`; audit summary (not every line)

## Uncosted surplus

Inventory surplus has **unknown** purchase cost. Never invent price, last price, average, or `0.00`.

API (with `purchase_price.view`):

- `averagePurchaseCost: null` when any remaining lot is uncosted
- `hasUncostedStock: true`

UI: show `—` with tooltip about unknown cost.

## Permissions

| Permission         | Florist | Manager | Director |
| ------------------ | ------- | ------- | -------- |
| `inventory.view`   | yes     | yes     | yes      |
| `inventory.count`  | yes     | yes     | yes      |
| `inventory.manage` | no      | yes     | yes      |
| `inventory.adjust` | no      | yes     | yes      |

`inventory.adjust` = write-off (Phase 4). `inventory.manage` = start/complete/cancel.

## API

| Method | Path                             | Permission    |
| ------ | -------------------------------- | ------------- |
| GET    | `/inventories`                   | view          |
| GET    | `/inventories/active`            | view          |
| GET    | `/inventories/:id`               | view          |
| POST   | `/inventories`                   | manage        |
| POST   | `/inventories/start-new`         | manage        |
| POST   | `/inventories/:id/start`         | manage        |
| PATCH  | `/inventories/:id/items/:itemId` | count         |
| PATCH  | `/inventories/:id/items`         | count (batch) |
| POST   | `/inventories/:id/complete`      | manage        |
| POST   | `/inventories/:id/cancel`        | manage        |

## Audit

- `INVENTORY_CREATED`
- `INVENTORY_STARTED`
- `INVENTORY_COMPLETED` (metadata: itemCount, differenceItemCount, positiveQuantity, negativeQuantity)
- `INVENTORY_CANCELLED`

Per-keystroke count audits are not written; `countedByUserId` / `countedAt` on items provide operational traceability.

## UI

- `/app/inventories` — list + start
- `/app/inventories/[id]` — count screen, filters, complete summary
- Warehouse banner while active; disable supply post / write-off

## Migration

`20260914220000_inventory_stocktake`

## Future (not Phase 5)

Partial/category inventory, cost reconciliation for uncosted lots, barcode scanners, multi-location.
