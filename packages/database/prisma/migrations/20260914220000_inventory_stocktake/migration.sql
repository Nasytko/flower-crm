-- Phase 5: Inventory / Stocktake + uncosted inventory surplus lots

CREATE TYPE "InventoryStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "StockLotSource" AS ENUM ('SUPPLY', 'INVENTORY');

CREATE SEQUENCE inventory_number_seq START 1;

CREATE TABLE "inventory_sessions" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'DRAFT',
    "comment" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "completedByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_sessions_number_key" ON "inventory_sessions"("number");
CREATE INDEX "inventory_sessions_status_idx" ON "inventory_sessions"("status");
CREATE INDEX "inventory_sessions_createdAt_idx" ON "inventory_sessions"("createdAt");

-- At most one IN_PROGRESS inventory at a time (constant expression partial unique index).
CREATE UNIQUE INDEX "inventory_sessions_one_in_progress_uidx"
  ON "inventory_sessions" ((1))
  WHERE "status" = 'IN_PROGRESS';

ALTER TABLE "inventory_sessions"
  ADD CONSTRAINT "inventory_sessions_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_sessions"
  ADD CONSTRAINT "inventory_sessions_completedByUserId_fkey"
  FOREIGN KEY ("completedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "inventorySessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expectedQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "countedByUserId" TEXT,
    "countedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_items_inventorySessionId_productId_key"
  ON "inventory_items"("inventorySessionId", "productId");
CREATE INDEX "inventory_items_inventorySessionId_idx" ON "inventory_items"("inventorySessionId");
CREATE INDEX "inventory_items_productId_idx" ON "inventory_items"("productId");

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_expected_nonneg"
  CHECK ("expectedQuantity" >= 0);

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_counted_nonneg"
  CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_inventorySessionId_fkey"
  FOREIGN KEY ("inventorySessionId") REFERENCES "inventory_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_countedByUserId_fkey"
  FOREIGN KEY ("countedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- StockLot: allow supply OR inventory origin; nullable purchase price for uncosted surplus.
ALTER TABLE "stock_lots" ADD COLUMN "sourceType" "StockLotSource";
ALTER TABLE "stock_lots" ADD COLUMN "inventoryItemId" TEXT;

UPDATE "stock_lots" SET "sourceType" = 'SUPPLY' WHERE "sourceType" IS NULL;

ALTER TABLE "stock_lots" ALTER COLUMN "sourceType" SET NOT NULL;
ALTER TABLE "stock_lots" ALTER COLUMN "supplyItemId" DROP NOT NULL;
ALTER TABLE "stock_lots" ALTER COLUMN "unitPurchasePrice" DROP NOT NULL;

CREATE UNIQUE INDEX "stock_lots_inventoryItemId_key" ON "stock_lots"("inventoryItemId");
CREATE INDEX "stock_lots_sourceType_idx" ON "stock_lots"("sourceType");

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_exactly_one_source"
  CHECK (
    (
      "sourceType" = 'SUPPLY'
      AND "supplyItemId" IS NOT NULL
      AND "inventoryItemId" IS NULL
      AND "unitPurchasePrice" IS NOT NULL
    )
    OR
    (
      "sourceType" = 'INVENTORY'
      AND "inventoryItemId" IS NOT NULL
      AND "supplyItemId" IS NULL
    )
  );

-- Allocations may reference uncosted lots.
ALTER TABLE "stock_movement_lot_allocations" ALTER COLUMN "unitPurchasePrice" DROP NOT NULL;
