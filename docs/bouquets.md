# Bouquets (Phase 6)

Bouquet is a **reusable recipe / catalog template**, not inventory.

## Domain

| Concept       | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| `Bouquet`     | Named sale recipe with `salePrice`                      |
| `BouquetItem` | Product component (`FLOWER` or `SERVICE`) with quantity |

Bouquet does **not** have:

- `ProductStock`
- `StockLot`
- `StockMovement`
- `quantityOnHand` / `quantityReserved`

Creating/editing/deactivating a bouquet **never** mutates warehouse stock.

## Composition rules

- At least one component
- At least one **FLOWER**
- Unique `(bouquetId, productId)` — no duplicate lines
- Quantity > 0
- New/edited composition may only add **active** products
- Existing recipes keep inactive products readable; availability becomes 0; reactivation rejected until fixed

## Availability

For each FLOWER line:

`floor(availableQuantity / recipeQuantity)`

where `availableQuantity = quantityOnHand - quantityReserved`.

Bouquet available count = **MIN** across FLOWER lines.

SERVICE does **not** constrain availability.

Inactive component → `availableBouquets = 0`, `hasInactiveComponents = true`.

## Estimated current cost

Informational only (Russian UI: «Расчётная себестоимость»).

| Component | Cost source                                           |
| --------- | ----------------------------------------------------- |
| FLOWER    | Current weighted average of remaining **costed** lots |
| SERVICE   | `Product.purchasePrice`                               |

If any component has unknown cost (uncosted lots, null service cost, no remaining costed stock):

- `estimatedCurrentCost: null`
- `hasUnknownCost: true`

Do **not** invent last price / zero / partial “average of all stock”.

### Margin preview

When cost is known:

- `estimatedMargin = salePrice - estimatedCurrentCost`
- `estimatedMarginPercent = margin / salePrice * 100` (if salePrice > 0)

Not persisted. Tooltip: actual order COGS may differ (future FIFO allocations).

## Optimistic concurrency

`Bouquet.version` starts at 1. `PATCH` requires `expectedVersion`. The version check is enforced atomically in the database (`UPDATE … WHERE id AND version = expectedVersion`) **before** recipe `deleteMany`/`createMany`, so concurrent writers cannot interleave composition under READ COMMITTED. Mismatch or concurrent race → `BOUQUET_CONFLICT` (409); composition changes roll back with the transaction.

This is **not** recipe history. AuditLog covers admin history.

## Order snapshot (Phase 7 — implemented)

When a Bouquet is added to an Order, composition is **copied** into `OrderItemComponent`.

Historical orders must **not** depend on live `BouquetItem` rows.

## Permissions

|                      | Florist | Manager                     | Director |
| -------------------- | ------- | --------------------------- | -------- |
| `bouquets.view`      | yes     | yes                         | yes      |
| `bouquets.manage`    | no      | yes                         | yes      |
| cost / margin fields | no      | yes (`purchase_price.view`) | yes      |

Backend omits cost fields without `purchase_price.view`.

## API

| Method | Path            | Permission |
| ------ | --------------- | ---------- |
| GET    | `/bouquets`     | view       |
| GET    | `/bouquets/:id` | view       |
| POST   | `/bouquets`     | manage     |
| PATCH  | `/bouquets/:id` | manage     |

## Audit

`BOUQUET_CREATED` · `BOUQUET_UPDATED` · `BOUQUET_DEACTIVATED` · `BOUQUET_REACTIVATED`

## Migration

`20260914230000_bouquets`

## Inventory freeze

Bouquet CRUD is allowed while an inventory is `IN_PROGRESS` (no physical stock mutation).
