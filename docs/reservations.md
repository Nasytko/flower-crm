# Reservations (planned reserve)

Soft allocation of **unassembled** FLOWER stock to active orders (`NEW` / `IN_PROGRESS` / `READY`).

## Three stock buckets

For every FLOWER `ProductStock`:

```
available            = quantityOnHand − quantityReserved
unassembledPhysical  = quantityOnHand          (= available + planned reserve)
totalPhysical        = quantityOnHand + quantityInBouquets
```

- **Доступно** — free unassembled stems.
- **Плановый резерв** — soft promise to unassembled order needs (not lot-pinned).
- **В готовых букетах** — stems inside `AssembledBouquet` with status `ASSEMBLED` (not auto-reallocated).

Aggregates are projections. Source of truth: stock movements + lots + `AssembledBouquetComponent*`.

## Open requirements

Planned reserve covers only **still-open** needs:

`required = snapshot need − components in ASSEMBLED/ISSUED bouquets − direct-issued PRODUCT qty`

## Preemption

Full recompute by fulfillment priority. Later orders **lose** reserve to earlier ones.

Priority (ascending = served first):

1. `fulfillmentDate`
2. Timed before no-time (`fulfillmentTimeFrom` null last)
3. `fulfillmentTimeFrom`
4. `createdAt`
5. `number` / reservation `id`

## Lot suitability vs physical pick

- **Promising (reserve):** virtual FEFO capacity — do not promise lots whose *effective* usable date is before the order date.
- **Null `usableUntil`:** not infinite — see [lot-suitability.md](./lot-suitability.md) (`receivedAt + UNKNOWN_LOT_SHELF_DAYS`).
- **Physical pick (assemble / direct-issue):** FEFO order (`usableUntil`, then `receivedAt`); **cost** is taken from the selected lots (not a separate FIFO cost layer).

## Assembly / issue

- Assemble moves onHand → inBouquets (`ASSEMBLE`), pins lots, recalculates reserve.
- Cannot silently consume another order’s higher-priority reserve without `allowReserveOverride` + `ORDERS_RESERVE_OVERRIDE` + audit.
- Issue / direct-issue finally leave the shop (`ISSUE` / `DIRECT_ISSUE`).
- Cancel releases reserve only — does **not** auto-disassemble.

## Lock order

1. Warehouse advisory xact lock
2. Business document
3. `ProductStock` `FOR UPDATE` (sorted productId)
4. `StockReservation` / lots as needed
