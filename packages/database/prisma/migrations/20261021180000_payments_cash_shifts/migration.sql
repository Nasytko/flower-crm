-- Payments, cash shifts, and OrderPaymentStatus rename (PARTIAL → PARTIALLY_PAID).
-- Additive / safe for existing Stage-1 POS data.

-- Rename unused enum value (nothing has written PARTIAL yet).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'OrderPaymentStatus' AND e.enumlabel = 'PARTIAL'
  ) THEN
    ALTER TYPE "OrderPaymentStatus" RENAME VALUE 'PARTIAL' TO 'PARTIALLY_PAID';
  END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM (
    'CASH', 'CARD_TERMINAL', 'ERIP', 'ONLINE_CARD', 'BANK_TRANSFER', 'GIFT_CERTIFICATE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentSource" AS ENUM ('POS', 'BACKOFFICE', 'WEBSITE', 'EXTERNAL_INTEGRATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM (
    'PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentKind" AS ENUM ('CHARGE', 'REFUND');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CashShiftStatus" AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CashMovementType" AS ENUM (
    'SALE_IN', 'REFUND_OUT', 'FLOAT_IN', 'FLOAT_OUT', 'ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "cash_registers" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cash_registers_code_key" ON "cash_registers"("code");

INSERT INTO "cash_registers" ("id", "code", "name", "isActive", "createdAt", "updatedAt")
VALUES ('cashreg_main', 'MAIN', 'Основная касса', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

CREATE TABLE IF NOT EXISTS "cash_shifts" (
  "id" TEXT NOT NULL,
  "cashRegisterId" TEXT NOT NULL,
  "status" "CashShiftStatus" NOT NULL DEFAULT 'OPEN',
  "openedByUserId" TEXT NOT NULL,
  "closedByUserId" TEXT,
  "openingFloat" DECIMAL(12, 2) NOT NULL,
  "expectedCash" DECIMAL(12, 2),
  "countedCash" DECIMAL(12, 2),
  "discrepancy" DECIMAL(12, 2),
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cash_shifts_cashRegisterId_status_idx" ON "cash_shifts"("cashRegisterId", "status");
CREATE INDEX IF NOT EXISTS "cash_shifts_status_openedAt_idx" ON "cash_shifts"("status", "openedAt");

ALTER TABLE "cash_shifts" DROP CONSTRAINT IF EXISTS "cash_shifts_cashRegisterId_fkey";
ALTER TABLE "cash_shifts"
  ADD CONSTRAINT "cash_shifts_cashRegisterId_fkey"
  FOREIGN KEY ("cashRegisterId") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_shifts" DROP CONSTRAINT IF EXISTS "cash_shifts_openedByUserId_fkey";
ALTER TABLE "cash_shifts"
  ADD CONSTRAINT "cash_shifts_openedByUserId_fkey"
  FOREIGN KEY ("openedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_shifts" DROP CONSTRAINT IF EXISTS "cash_shifts_closedByUserId_fkey";
ALTER TABLE "cash_shifts"
  ADD CONSTRAINT "cash_shifts_closedByUserId_fkey"
  FOREIGN KEY ("closedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "payments" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "kind" "PaymentKind" NOT NULL DEFAULT 'CHARGE',
  "amount" DECIMAL(12, 2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'BYN',
  "method" "PaymentMethod" NOT NULL,
  "source" "PaymentSource" NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "parentPaymentId" TEXT,
  "externalTransactionId" TEXT,
  "externalProvider" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "cashShiftId" TEXT,
  "isManual" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "metadata" JSONB,
  "createdByUserId" TEXT NOT NULL,
  "confirmedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payments_idempotencyKey_key" ON "payments"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "payments_externalProvider_externalTransactionId_key"
  ON "payments"("externalProvider", "externalTransactionId");
CREATE INDEX IF NOT EXISTS "payments_orderId_status_idx" ON "payments"("orderId", "status");
CREATE INDEX IF NOT EXISTS "payments_cashShiftId_idx" ON "payments"("cashShiftId");
CREATE INDEX IF NOT EXISTS "payments_parentPaymentId_idx" ON "payments"("parentPaymentId");
CREATE INDEX IF NOT EXISTS "payments_createdAt_idx" ON "payments"("createdAt");

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_orderId_fkey";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_parentPaymentId_fkey";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_parentPaymentId_fkey"
  FOREIGN KEY ("parentPaymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_cashShiftId_fkey";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_cashShiftId_fkey"
  FOREIGN KEY ("cashShiftId") REFERENCES "cash_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_createdByUserId_fkey";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_confirmedByUserId_fkey";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "cash_movements" (
  "id" TEXT NOT NULL,
  "cashShiftId" TEXT NOT NULL,
  "type" "CashMovementType" NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  "paymentId" TEXT,
  "note" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cash_movements_cashShiftId_createdAt_idx" ON "cash_movements"("cashShiftId", "createdAt");
CREATE INDEX IF NOT EXISTS "cash_movements_paymentId_idx" ON "cash_movements"("paymentId");

ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_cashShiftId_fkey";
ALTER TABLE "cash_movements"
  ADD CONSTRAINT "cash_movements_cashShiftId_fkey"
  FOREIGN KEY ("cashShiftId") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_paymentId_fkey";
ALTER TABLE "cash_movements"
  ADD CONSTRAINT "cash_movements_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_createdByUserId_fkey";
ALTER TABLE "cash_movements"
  ADD CONSTRAINT "cash_movements_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
