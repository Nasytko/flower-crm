-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('FLOWER', 'SERVICE');

-- CreateEnum
CREATE TYPE "Unit" AS ENUM ('PIECE');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM (
  'SUPPLY',
  'SALE',
  'WRITE_OFF',
  'RETURN',
  'INVENTORY_ADJUSTMENT',
  'MANUAL_ADJUSTMENT'
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "type" "ProductType" NOT NULL,
    "description" TEXT,
    "unit" "Unit" NOT NULL,
    "purchasePrice" DECIMAL(12,2),
    "salePrice" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stocks" (
    "productId" TEXT NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "quantityReserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_stocks_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "comment" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");
CREATE INDEX "products_type_isActive_idx" ON "products"("type", "isActive");
CREATE INDEX "products_name_idx" ON "products"("name");
CREATE INDEX "products_isActive_name_idx" ON "products"("isActive", "name");
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt");
CREATE INDEX "stock_movements_type_idx" ON "stock_movements"("type");
CREATE INDEX "stock_movements_createdAt_idx" ON "stock_movements"("createdAt");

-- ForeignKeys
ALTER TABLE "product_stocks"
  ADD CONSTRAINT "product_stocks_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Stock invariants (DB-level)
ALTER TABLE "product_stocks"
  ADD CONSTRAINT "product_stocks_quantity_on_hand_non_negative"
  CHECK ("quantityOnHand" >= 0);

ALTER TABLE "product_stocks"
  ADD CONSTRAINT "product_stocks_quantity_reserved_non_negative"
  CHECK ("quantityReserved" >= 0);

ALTER TABLE "product_stocks"
  ADD CONSTRAINT "product_stocks_reserved_lte_on_hand"
  CHECK ("quantityReserved" <= "quantityOnHand");

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_quantity_nonzero"
  CHECK ("quantity" <> 0);

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_balance_after_non_negative"
  CHECK ("balanceAfter" >= 0);
