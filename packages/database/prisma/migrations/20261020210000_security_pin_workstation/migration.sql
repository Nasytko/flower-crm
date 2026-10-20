-- PIN quick unlock, trusted devices, work sessions, security policy.

CREATE TYPE "AuthStrength" AS ENUM ('PASSWORD', 'PIN');
CREATE TYPE "DeviceAccessMode" AS ENUM ('ALL_PIN_USERS', 'SELECTED_USERS');
CREATE TYPE "WorkSessionCloseReason" AS ENUM ('MANUAL', 'LOGOUT', 'EXPIRED', 'DEVICE_REVOKED', 'FORCE');

ALTER TABLE "users"
  ADD COLUMN "pinEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pinHash" TEXT,
  ADD COLUMN "pinUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

CREATE INDEX "users_pinEnabled_isActive_idx" ON "users"("pinEnabled", "isActive");

CREATE TABLE "security_policies" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "pinEnabledOrg" BOOLEAN NOT NULL DEFAULT true,
  "deviceTrustDays" INTEGER NOT NULL DEFAULT 30,
  "workSessionMaxHours" INTEGER NOT NULL DEFAULT 12,
  "idleLockMinutes" INTEGER NOT NULL DEFAULT 5,
  "pinMaxAttempts" INTEGER NOT NULL DEFAULT 5,
  "pinLockoutMinutes" INTEGER NOT NULL DEFAULT 15,
  "allowEmployeeSwitch" BOOLEAN NOT NULL DEFAULT true,
  "requirePasswordForWorkSession" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedByUserId" TEXT,
  CONSTRAINT "security_policies_pkey" PRIMARY KEY ("id")
);

INSERT INTO "security_policies" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP);

CREATE TABLE "trusted_devices" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "accessMode" "DeviceAccessMode" NOT NULL DEFAULT 'ALL_PIN_USERS',
  "createdByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trusted_devices_tokenHash_key" ON "trusted_devices"("tokenHash");
CREATE INDEX "trusted_devices_revokedAt_expiresAt_idx" ON "trusted_devices"("revokedAt", "expiresAt");

ALTER TABLE "trusted_devices"
  ADD CONSTRAINT "trusted_devices_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "trusted_device_users" (
  "deviceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trusted_device_users_pkey" PRIMARY KEY ("deviceId", "userId")
);

CREATE INDEX "trusted_device_users_userId_idx" ON "trusted_device_users"("userId");

ALTER TABLE "trusted_device_users"
  ADD CONSTRAINT "trusted_device_users_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "trusted_devices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trusted_device_users"
  ADD CONSTRAINT "trusted_device_users_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "work_sessions" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "openedByUserId" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "closeReason" "WorkSessionCloseReason",
  "lockedAt" TIMESTAMP(3),
  "lastUserActivityAt" TIMESTAMP(3),
  CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_sessions_deviceId_closedAt_idx" ON "work_sessions"("deviceId", "closedAt");
CREATE INDEX "work_sessions_expiresAt_idx" ON "work_sessions"("expiresAt");

ALTER TABLE "work_sessions"
  ADD CONSTRAINT "work_sessions_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "trusted_devices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_sessions"
  ADD CONSTRAINT "work_sessions_openedByUserId_fkey"
  FOREIGN KEY ("openedByUserId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sessions"
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "authStrength" "AuthStrength" NOT NULL DEFAULT 'PASSWORD',
  ADD COLUMN "elevatedUntil" TIMESTAMP(3),
  ADD COLUMN "workSessionId" TEXT,
  ADD COLUMN "lastUserActivityAt" TIMESTAMP(3);

CREATE INDEX "sessions_workSessionId_idx" ON "sessions"("workSessionId");
CREATE INDEX "sessions_lockedAt_idx" ON "sessions"("lockedAt");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_workSessionId_fkey"
  FOREIGN KEY ("workSessionId") REFERENCES "work_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
