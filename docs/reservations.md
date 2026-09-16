# Reservations

Mutable `StockReservation` engine for active orders (NEW / READY). Shared by orders, supply post, inventory adjustments, and write-off guards.

## Invariants

For every FLOWER `ProductStock`:

```
0 ≤ quantityReserved ≤ quantityOnHand
available = quantityOnHand − quantityReserved
```

Per active order and product:

```
0 ≤ reservedQuantity ≤ requiredQuantity
shortageQuantity = requiredQuantity − reservedQuantity
```

- Only **FLOWER** lines/components create requirements (SERVICE never reserved).
- Requirements are built from the **order snapshot**, not live bouquet recipes.
- Sum of `StockReservation.reservedQuantity` for a product equals `ProductStock.quantityReserved`.

## Lock order (deadlock-safe)

Compatible with other warehouse mutations:

1. Warehouse advisory xact lock (`WarehouseLockService` / `beginStockMutation` when mutating onHand)
2. Business document row (order / supply / inventory) — caller
3. `ProductStock` rows `FOR UPDATE`, sorted by `productId`
4. `StockReservation` rows (via locked stock / `FOR UPDATE OF r` in allocate query)
5. `StockLot` rows FIFO (`receivedAt`, `createdAt`, `id`) — completion / write-off only

Never lock lots before stocks; never lock stocks in non-sorted product id order across transactions.

## Allocation rules

**No preemption.** Existing reservations are never reduced to satisfy a higher-priority shortage. Priority applies only when distributing **new or released** available stock.

Priority (ascending = served first):

1. `fulfillmentDate`
2. Timed before no-time (`fulfillmentTimeFrom` null last)
3. `fulfillmentTimeFrom`
4. `createdAt`
5. `number`

Triggers that allocate available → shortages:

- Order create / update reconcile (may fill self, then reallocate released)
- Supply post
- Order cancel (release then reallocate)
- Inventory surplus / other paths that increase available

## Lifecycle hooks

| Event                 | Behavior                                                              |
| --------------------- | --------------------------------------------------------------------- |
| Order create/update   | Reconcile required qty; fill from available; release excess           |
| Order cancel          | Delete reservations; decrease `quantityReserved`; reallocate          |
| Order → READY         | Assert no shortage                                                    |
| Order → COMPLETED     | Assert no shortage; FIFO consume reserved; SALE movements; clear rows |
| Manual write-off      | May only consume `available` (reserved protected)                     |
| Inventory in progress | Blocks stock mutations including completion consume                   |

## API surface (orders)

List/detail expose `hasShortage`, `shortageProductCount`, and detail `requirements[]` (`product`, need, reserve, shortage). Cost fields (`actualCost`, `grossProfit`, `hasUncostedConsumption`) require `purchase_price.view`.
