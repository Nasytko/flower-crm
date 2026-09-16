# Audit Log

## Purpose

`AuditLog` records security-relevant and administrative actions for later investigation.

## Model

- `actorUserId` nullable (failed login may have no actor)
- `action`
- `entityType` / `entityId`
- `before` / `after` / `metadata` JSON
- `ipAddress` / `userAgent` / `requestId`
- `createdAt`

## Events (Phase 2)

- `LOGIN_SUCCESS`
- `LOGIN_FAILED`
- `LOGOUT`
- `LOGOUT_ALL`
- `PASSWORD_CHANGED`
- `PASSWORD_RESET`
- `EMPLOYEE_CREATED`
- `EMPLOYEE_UPDATED`
- `EMPLOYEE_DEACTIVATED`
- `EMPLOYEE_REACTIVATED`
- `SESSION_REVOKED`

## Events (Phase 3+)

- `PRODUCT_CREATED`
- `PRODUCT_UPDATED`
- `PRODUCT_DEACTIVATED`
- `PRODUCT_REACTIVATED`
- `STOCK_WRITTEN_OFF` — manual write-off (FIFO); metadata: product/qty/movement
- `SUPPLY_*` / `INVENTORY_*` / `BOUQUET_*` — see module docs

`STOCK_MANUAL_ADJUSTED` remains in the shared enum for historical compatibility but is **not emitted** by current code (arbitrary manual +stock was removed; use supplies / write-off / inventory).

Stock physical history lives in `StockMovement`; audit records the administrative action. See `docs/inventory.md`.

## What must never be logged

`AuditService` sanitizes payloads and strips at least:

- `password`
- `passwordHash`
- `currentPassword` / `newPassword` / `confirmPassword`
- `token` / `accessToken` / `refreshToken`
- `authorization`
- `cookie` / `cookies`

Do not bypass `AuditService` with raw password-bearing objects.

## API

`GET /api/v1/audit`

Requires `audit.view`.

Supports:

- pagination (`page`, `limit`, max 100)
- filters: `actorUserId`, `action`, `entityType`, `entityId`, `dateFrom`, `dateTo`
