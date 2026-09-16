# Authentication

## Model

Phase 2 uses a split token model:

- **Access token** — short-lived JWT (default 15 minutes), returned in the login/refresh JSON body and kept **in memory** on the frontend.
- **Refresh / session token** — cryptographically random opaque token, stored in an **HttpOnly** cookie, hashed (SHA-256) in the `Session` table.

Raw refresh tokens are never stored in the database.

## Login

`POST /api/v1/auth/login`

1. Validate DTO.
2. Find user by `login`.
3. Reject unknown or inactive users with the same external error as bad credentials. For those cases the server still runs a **dummy Argon2id verification** (same cost parameters as real passwords) so response timing does not reveal whether the login exists.
4. Verify password with Argon2id for active users.
5. Create `Session`.
6. Issue access JWT + refresh cookie.
7. Update `lastLoginAt`.
8. Write `LOGIN_SUCCESS` audit event.

Failed attempts write `LOGIN_FAILED` without storing the password. The public error is always `INVALID_CREDENTIALS`.

Login is rate-limited via a dedicated `login` throttler configured from `AUTH_LOGIN_MAX_ATTEMPTS` / `AUTH_LOGIN_WINDOW_SECONDS` at startup. General API traffic uses a separate higher default budget (120/min).

## Access token

JWT claims:

- `sub` — user id
- `sid` — session id
- `role`
- `login`

Signed and verified with **HS256** explicitly.

Every protected request sends `Authorization: Bearer <accessToken>`.

The auth guard also re-checks:

- user exists and `isActive`
- session exists, is not revoked, and is not expired

So a deactivated employee loses access even if an access token has not expired yet.

## Refresh / session cookie

Cookie name: `AUTH_COOKIE_NAME` (default `erp_refresh`)

Flags:

- `HttpOnly=true`
- `Secure=true` in production
- `SameSite=Lax`
- `Path=/api/v1/auth`

Refresh rotates the opaque token atomically (`UPDATE … WHERE tokenHash = current`). Concurrent refresh: only one wins; losers get 401.

After rotation the previous hash is kept in `Session.previousTokenHash`. Presenting that old token again **after a short grace window** (10s) is treated as **reuse/theft**: all sessions for the user are revoked. Presentations inside the grace window are treated as lost concurrent refresh races (401, no mass revoke).

## Session cleanup

Expired and long-revoked sessions are rejected by auth checks but rows remain until cleaned.

`SessionService.cleanupStaleSessions(retentionDays?)` deletes:

- sessions with `expiresAt < now`
- sessions with `revokedAt` older than retention (default 30 days)

Call from a future scheduled job/ops script. No in-process cron is registered in Phase 2.

## Logout

- `POST /api/v1/auth/logout` — revokes current session, clears cookie (same Path/SameSite/Secure attributes as set)
- `POST /api/v1/auth/logout-all` — revokes all sessions for the current user

## Session revocation

Sessions are revoked when:

- logout / logout-all
- employee deactivation
- director password reset
- self password change (other sessions)
- refresh-token reuse detection

## CSRF strategy

Access tokens are **not** stored in cookies, so ordinary authenticated API calls are not cookie-authenticated and are not CSRF-prone in the classic sense.

Cookie-authenticated mutating endpoints (`/auth/login`, `/auth/refresh`, `/auth/logout`, password change) are additionally protected by `OriginGuard`:

- browser requests must match `WEB_URL`
- in **production**, missing Origin and Referer is rejected
- in development/test, missing both headers is allowed (curl / automated tests)
- SameSite=Lax on the refresh cookie
- CORS `credentials: true` with fixed `WEB_URL` origin

CSRF tokens are intentionally not used for Phase 2.

## Trust proxy

`TRUST_PROXY` controls Express `trust proxy` (default **disabled** / `false`).

- Local / direct API access: leave unset or `false` so `X-Forwarded-For` cannot spoof `request.ip` used by rate limiting and audit.
- Production behind one nginx hop: set `TRUST_PROXY=1`.
- Only non-negative integer hop counts (or `true` → `1`) are accepted; arbitrary strings are rejected at startup.

## Passwords

- Argon2id (`memoryCost=19456`, `timeCost=2`, `parallelism=1` — OWASP minimum)
- Create / reset / change password: min length **10**, max **128**
- Login DTO min length **8** (credential check still goes through Argon2)
- passwords / hashes are never logged and never returned by API

## Frontend handling

- access token lives only in React memory
- refresh uses shared single-flight (`refreshSession`) for bootstrap and 401 retry
- TanStack Query does not retry 401/403
- failed refresh clears auth state **and TanStack Query cache** (so purchase-price data cannot linger after logout / user switch)
- login clears QueryClient before applying the new session
- no `localStorage` / `sessionStorage` for tokens
