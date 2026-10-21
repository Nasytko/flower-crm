-- Three-bucket warehouse: planned reserve + physical assembled bouquets + dynamic preemption.
-- Additive / replace-in-place for empty operational data. Does NOT truncate production tables.

-- OrderStatus: IN_PROGRESS
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS' BEFORE 'READY';

-- AssembledBouquetStatus
CREATE TYPE "AssembledBouquetStatus" AS ENUM ('ASSEMBLED', 'DISASSEMBLED', 'ISSUED', 'WRITTEN_OFF');

-- StockMovementType extensions
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'ASSEMBLE';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'DISASSEMBLE_RETURN';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'DISASSEMBLE_DAMAGE';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'ISSUE';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'DIRECT_ISSUE';

-- ProductStock: in-bouquets aggregate
ALTER TABLE "product_stocks"
  ADD COLUMN IF NOT EXISTS "quantityInBouquets" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "product_stocks"
  DROP CONSTRAINT IF EXISTS "product_stocks_in_bouquets_nonneg";
ALTER TABLE "product_stocks"
  ADD CONSTRAINT "product_stocks_in_bouquets_nonneg" CHECK ("quantityInBouquets" >= 0);

-- StockLot suitability
ALTER TABLE "stock_lots"
  ADD COLUMN IF NOT EXISTS "usableUntil" DATE;

CREATE INDEX IF NOT EXISTS "stock_lots_productId_usableUntil_idx"
  ON "stock_lots"("productId", "usableUntil");

-- Order: inProgressAt
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "inProgressAt" TIMESTAMP(3);

-- OrderItem: quantityIssued
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "quantityIssued" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "order_items"
  DROP CONSTRAINT IF EXISTS "order_items_quantity_issued_nonneg";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_issued_nonneg" CHECK ("quantityIssued" >= 0);

ALTER TABLE "order_items"
  DROP CONSTRAINT IF EXISTS "order_items_quantity_issued_lte_qty";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_issued_lte_qty" CHECK ("quantityIssued" <= "quantity");

CREATE TABLE IF NOT EXISTS "assembled_bouquet_daily_counters" (
    "businessDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assembled_bouquet_daily_counters_pkey" PRIMARY KEY ("businessDate"),
    CONSTRAINT "assembled_bouquet_daily_counters_last_number_positive" CHECK ("lastNumber" > 0)
);

-- Assembled bouquets
CREATE TABLE IF NOT EXISTS "assembled_bouquets" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "AssembledBouquetStatus" NOT NULL DEFAULT 'ASSEMBLED',
    "orderId" TEXT,
    "orderItemId" TEXT,
    "bouquetTemplateId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "unitCost" DECIMAL(12,2),
    "hasUncostedComponents" BOOLEAN NOT NULL DEFAULT false,
    "assembledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assembledByUserId" TEXT NOT NULL,
    "disassembledAt" TIMESTAMP(3),
    "disassembledByUserId" TEXT,
    "disassembleReason" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedByUserId" TEXT,
    "writtenOffAt" TIMESTAMP(3),
    "writtenOffByUserId" TEXT,
    "writeOffReason" TEXT,
    "lastAdjustedAt" TIMESTAMP(3),
    "lastAdjustedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assembled_bouquets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assembled_bouquets_version_positive" CHECK ("version" > 0),
    CONSTRAINT "assembled_bouquets_unit_cost_nonneg" CHECK ("unitCost" IS NULL OR "unitCost" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "assembled_bouquets_number_key" ON "assembled_bouquets"("number");
CREATE UNIQUE INDEX IF NOT EXISTS "assembled_bouquets_idempotencyKey_key" ON "assembled_bouquets"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "assembled_bouquets_status_idx" ON "assembled_bouquets"("status");
CREATE INDEX IF NOT EXISTS "assembled_bouquets_orderId_idx" ON "assembled_bouquets"("orderId");
CREATE INDEX IF NOT EXISTS "assembled_bouquets_orderItemId_idx" ON "assembled_bouquets"("orderItemId");
CREATE INDEX IF NOT EXISTS "assembled_bouquets_assembledAt_idx" ON "assembled_bouquets"("assembledAt");

CREATE TABLE IF NOT EXISTS "assembled_bouquet_components" (
    "id" TEXT NOT NULL,
    "assembledBouquetId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assembled_bouquet_components_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assembled_bouquet_components_qty_positive" CHECK ("quantity" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "assembled_bouquet_components_assembledBouquetId_productId_key"
  ON "assembled_bouquet_components"("assembledBouquetId", "productId");
CREATE INDEX IF NOT EXISTS "assembled_bouquet_components_assembledBouquetId_idx"
  ON "assembled_bouquet_components"("assembledBouquetId");
CREATE INDEX IF NOT EXISTS "assembled_bouquet_components_productId_idx"
  ON "assembled_bouquet_components"("productId");

CREATE TABLE IF NOT EXISTS "assembled_bouquet_component_lots" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "stockLotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,
    "unitPurchasePrice" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assembled_bouquet_component_lots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assembled_bouquet_component_lots_qty_positive" CHECK ("quantity" > 0),
    CONSTRAINT "assembled_bouquet_component_lots_remaining_nonneg" CHECK ("remainingQuantity" >= 0),
    CONSTRAINT "assembled_bouquet_component_lots_remaining_lte_qty" CHECK ("remainingQuantity" <= "quantity"),
    CONSTRAINT "assembled_bouquet_component_lots_price_nonneg" CHECK ("unitPurchasePrice" IS NULL OR "unitPurchasePrice" >= 0)
);

CREATE INDEX IF NOT EXISTS "assembled_bouquet_component_lots_componentId_idx"
  ON "assembled_bouquet_component_lots"("componentId");
CREATE INDEX IF NOT EXISTS "assembled_bouquet_component_lots_stockLotId_idx"
  ON "assembled_bouquet_component_lots"("stockLotId");

-- FKs
DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_bouquetTemplateId_fkey"
    FOREIGN KEY ("bouquetTemplateId") REFERENCES "bouquets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_assembledByUserId_fkey"
    FOREIGN KEY ("assembledByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_disassembledByUserId_fkey"
    FOREIGN KEY ("disassembledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_issuedByUserId_fkey"
    FOREIGN KEY ("issuedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_writtenOffByUserId_fkey"
    FOREIGN KEY ("writtenOffByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquets"
    ADD CONSTRAINT "assembled_bouquets_lastAdjustedByUserId_fkey"
    FOREIGN KEY ("lastAdjustedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquet_components"
    ADD CONSTRAINT "assembled_bouquet_components_assembledBouquetId_fkey"
    FOREIGN KEY ("assembledBouquetId") REFERENCES "assembled_bouquets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquet_components"
    ADD CONSTRAINT "assembled_bouquet_components_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquet_component_lots"
    ADD CONSTRAINT "assembled_bouquet_component_lots_componentId_fkey"
    FOREIGN KEY ("componentId") REFERENCES "assembled_bouquet_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assembled_bouquet_component_lots"
    ADD CONSTRAINT "assembled_bouquet_component_lots_stockLotId_fkey"
    FOREIGN KEY ("stockLotId") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
