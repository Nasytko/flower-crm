# Supplies & stock lots (Phase 4)

## Business rules

1. **Stock increase only via Supply** (or supply correction). Manual `+N` adjustment is removed.
2. **Manual decrease** = write-off with required reason (`POST /products/:id/stock/write-off`).
3. **FLOWER purchase cost** lives on **StockLot** (batch), not on `Product.purchasePrice`.
4. **Posted supplies are immutable**; errors go through **correction** (new document + reversal).

## Models

### Supply

Statuses: `DRAFT` → `POSTED` | `CANCELLED`.

- Human number from PostgreSQL sequence `supply_number_seq` → UI `П-000001`.
- `correctionOfSupplyId` links correction draft/document to original.
- `supplierName` is free text (no Supplier directory yet).

### SupplyItem

FLOWER only. `quantity > 0`, `unitPurchasePrice >= 0` (Decimal).

### StockLot

Created on post: `receivedQuantity`, `remainingQuantity`, `unitPurchasePrice`, `receivedAt`.

On reversal: `remainingQuantity = 0`, `reversedAt` set (row kept).

### StockMovementLotAllocation

Outbound (write-off) → FIFO lots with quantity + unit price snapshot.

## Average purchase cost (warehouse)

For remaining lots:

```
SUM(remainingQuantity * unitPurchasePrice) / SUM(remainingQuantity)
```

API: `averagePurchaseCost` string `"4.75"` when `purchase_price.view`.  
Zero remaining → field `null` / UI `—`.  
SERVICE still uses `Product.purchasePrice`.

## Posting transaction

1. Lock supply `FOR UPDATE`
2. Validate DRAFT + items + active FLOWER
3. Lock `product_stocks` by sorted `productId`
4. Increase on-hand, create lots, create `SUPPLY` movements
5. Mark POSTED + audit

Double-post → `SUPPLY_ALREADY_POSTED`.

## Correction

1. `POST /supplies/:id/correct` { reason } → DRAFT clone
2. Edit draft
3. `POST /supplies/:id/post` on correction:
   - assert original lots untouched (`remaining == received`)
   - reverse original (`SUPPLY_REVERSAL`, lots zeroed, CANCELLED)
   - post correction
4. If any lot consumed → `SUPPLY_ALREADY_CONSUMED` (no partial reverse)

## Write-off (FIFO)

1. Lock product stock
2. Lock lots `ORDER BY receivedAt, createdAt, id FOR UPDATE`
3. Consume oldest first; allocations; `MANUAL_WRITE_OFF` movement (−qty)
4. Audit `STOCK_WRITTEN_OFF`

## Permissions

|                                   | FLORIST | MANAGER | DIRECTOR |
| --------------------------------- | ------- | ------- | -------- |
| warehouse view                    | yes     | yes     | yes      |
| write-off                         | no      | yes     | yes      |
| supplies view/create/post/correct | no      | yes     | yes      |
| purchase costs in API             | no      | yes     | yes      |

## Migration

`20260914210000_supplies_lots`

## Not in Phase 4

Inventory sessions, Orders, Supplier directory, photo storage.
