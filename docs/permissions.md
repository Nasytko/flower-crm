# Permissions

## Roles

Enum `Role`:

- `FLORIST`
- `MANAGER`
- `DIRECTOR`

## Permissions

Stable identifiers (`@erp/shared`):

- `employees.view` / `employees.manage`
- `products.view` / `products.manage`
- `inventory.view` / `inventory.count` / `inventory.manage` / `inventory.adjust`
- `supplies.view` / `supplies.create` / `supplies.post` / `supplies.correct`
- `bouquets.view` / `bouquets.manage`
- `orders.view` / `orders.create` / `orders.update` / `orders.status` / `orders.cancel` / `orders.discount`
- `purchase_price.view`
- `audit.view`
- `settings.manage`

Inventory semantics (Phase 5):

- `inventory.view` — list/open stocktake documents
- `inventory.count` — enter physical counts
- `inventory.manage` — start / complete / cancel
- `inventory.adjust` — manual write-off (Phase 4)

Orders semantics (Phase 7):

- `orders.view` — list/open orders
- `orders.create` / `orders.update` — commercial document in NEW
- `orders.status` — NEW↔READY→COMPLETED
- `orders.cancel` — cancel (Manager+)
- `orders.discount` — discount and unit price override (Manager+)

## Matrix (Phase 7)

| Permission          | FLORIST | MANAGER | DIRECTOR |
| ------------------- | ------- | ------- | -------- |
| employees.view      | no      | yes     | yes      |
| employees.manage    | no      | no      | yes      |
| products.view       | yes     | yes     | yes      |
| products.manage     | no      | yes     | yes      |
| inventory.view      | yes     | yes     | yes      |
| inventory.count     | yes     | yes     | yes      |
| inventory.manage    | no      | yes     | yes      |
| inventory.adjust    | no      | yes     | yes      |
| supplies.view       | no      | yes     | yes      |
| supplies.create     | no      | yes     | yes      |
| supplies.post       | no      | yes     | yes      |
| supplies.correct    | no      | yes     | yes      |
| bouquets.view       | yes     | yes     | yes      |
| bouquets.manage     | no      | yes     | yes      |
| orders.view         | yes     | yes     | yes      |
| orders.create       | yes     | yes     | yes      |
| orders.update       | yes     | yes     | yes      |
| orders.status       | yes     | yes     | yes      |
| orders.cancel       | no      | yes     | yes      |
| orders.discount     | no      | yes     | yes      |
| purchase_price.view | no      | yes     | yes      |
| audit.view          | no      | yes     | yes      |
| settings.manage     | no      | no      | yes      |

Florist may view warehouse, bouquets, and help count inventory, but cannot manage stocktake, write-off, edit recipes, or see purchase costs.

Florist may operate orders (create/update/status) but cannot cancel or apply discounts / price overrides.

## Endpoint enforcement

Non-public API handlers must declare either:

- `@RequirePermissions(...)` — role must have all listed permissions; or
- `@Authenticated()` — any logged-in user (used for `/auth/me`, change-password, logout-all).

Omitting both fails closed with `FORBIDDEN` (prevents accidental open business endpoints). `@Public()` remains for login/refresh/logout/health.

## Purchase price

Without `purchase_price.view`, API omits:

- `averagePurchaseCost` / `hasUncostedStock` (FLOWER)
- `purchasePrice` (SERVICE)
- supply line prices / totals
- bouquet `estimatedCurrentCost` / `hasUnknownCost` / margins / component costs
