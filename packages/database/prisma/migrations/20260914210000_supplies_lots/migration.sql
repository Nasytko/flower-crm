-- Phase 4: supplies, stock lots, FIFO allocations

-- Enum extensions
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'SUPPLY_REVERSAL';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'MANUAL_WRITE_OFF';

CREATE TYPE "SupplyStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- Human-readable supply numbers (concurrency-safe)
CREATE SEQUENCE supply_number_seq START 1;

-- Supplies
CREATE TABLE "supplies" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "SupplyStatus" NOT NULL DEFAULT 'DRAFT',
    "documentDate" DATE NOT NULL,
    "supplierName" TEXT,
    "comment" TEXT,
    "correctionOfSupplyId" TEXT,
    "correctionReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "postedByUserId" TEXT,
    "cancelledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "supplies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplies_number_key" ON "supplies"("number");
CREATE INDEX "supplies_status_idx" ON "supplies"("status");
CREATE INDEX "supplies_documentDate_idx" ON "supplies"("documentDate");
CREATE INDEX "supplies_correctionOfSupplyId_idx" ON "supplies"("correctionOfSupplyId");
CREATE INDEX "supplies_createdAt_idx" ON "supplies"("createdAt");

ALTER TABLE "supplies"
  ADD CONSTRAINT "supplies_correctionOfSupplyId_fkey"
  FOREIGN KEY ("correctionOfSupplyId") REFERENCES "supplies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplies"
  ADD CONSTRAINT "supplies_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplies"
  ADD CONSTRAINT "supplies_postedByUserId_fkey"
  FOREIGN KEY ("postedByUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplies"
  ADD CONSTRAINT "supplies_cancelledByUserId_fkey"
  FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Supply items
CREATE TABLE "supply_items" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPurchasePrice" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supply_items_supplyId_idx" ON "supply_items"("supplyId");
CREATE INDEX "supply_items_productId_idx" ON "supply_items"("productId");

ALTER TABLE "supply_items"
  ADD CONSTRAINT "supply_items_supplyId_fkey"
  FOREIGN KEY ("supplyId") REFERENCES "supplies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supply_items"
  ADD CONSTRAINT "supply_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supply_items"
  ADD CONSTRAINT "supply_items_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "supply_items"
  ADD CONSTRAINT "supply_items_unit_purchase_price_non_negative"
  CHECK ("unitPurchasePrice" >= 0);

-- Stock lots
CREATE TABLE "stock_lots" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplyItemId" TEXT NOT NULL,
    "receivedQuantity" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,
    "unitPurchasePrice" DECIMAL(12,2) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_lots_supplyItemId_key" ON "stock_lots"("supplyItemId");
CREATE INDEX "stock_lots_productId_receivedAt_createdAt_idx"
  ON "stock_lots"("productId", "receivedAt", "createdAt");

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_supplyItemId_fkey"
  FOREIGN KEY ("supplyItemId") REFERENCES "supply_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_received_quantity_positive"
  CHECK ("receivedQuantity" > 0);

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_remaining_non_negative"
  CHECK ("remainingQuantity" >= 0);

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_remaining_lte_received"
  CHECK ("remainingQuantity" <= "receivedQuantity");

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_unit_purchase_price_non_negative"
  CHECK ("unitPurchasePrice" >= 0);

-- Lot allocations for outbound movements
CREATE TABLE "stock_movement_lot_allocations" (
    "id" TEXT NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "stockLotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPurchasePrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "stock_movement_lot_allocations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_movement_lot_allocations_stockMovementId_idx"
  ON "stock_movement_lot_allocations"("stockMovementId");
CREATE INDEX "stock_movement_lot_allocations_stockLotId_idx"
  ON "stock_movement_lot_allocations"("stockLotId");

ALTER TABLE "stock_movement_lot_allocations"
  ADD CONSTRAINT "stock_movement_lot_allocations_stockMovementId_fkey"
  FOREIGN KEY ("stockMovementId") REFERENCES "stock_movements"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movement_lot_allocations"
  ADD CONSTRAINT "stock_movement_lot_allocations_stockLotId_fkey"
  FOREIGN KEY ("stockLotId") REFERENCES "stock_lots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movement_lot_allocations"
  ADD CONSTRAINT "stock_movement_lot_allocations_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "stock_movement_lot_allocations"
  ADD CONSTRAINT "stock_movement_lot_allocations_unit_price_non_negative"
  CHECK ("unitPurchasePrice" >= 0);

CREATE INDEX "stock_movements_sourceType_sourceId_idx"
  ON "stock_movements"("sourceType", "sourceId");

-- FLOWER purchasePrice on Product is no longer authoritative; clear legacy seed values.
UPDATE "products"
SET "purchasePrice" = NULL
WHERE "type" = 'FLOWER';
