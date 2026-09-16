-- Phase 8: Order reservations, shortages, FIFO completion COGS.

ALTER TABLE "orders"
  ADD COLUMN "actualCost" DECIMAL(12,2),
  ADD COLUMN "hasUncostedConsumption" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_actual_cost_nonneg" CHECK ("actualCost" IS NULL OR "actualCost" >= 0);

CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requiredQuantity" INTEGER NOT NULL,
    "reservedQuantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_reservations_required_nonneg" CHECK ("requiredQuantity" >= 0),
    CONSTRAINT "stock_reservations_reserved_nonneg" CHECK ("reservedQuantity" >= 0),
    CONSTRAINT "stock_reservations_reserved_lte_required" CHECK ("reservedQuantity" <= "requiredQuantity")
);

CREATE UNIQUE INDEX "stock_reservations_orderId_productId_key" ON "stock_reservations"("orderId", "productId");
CREATE INDEX "stock_reservations_productId_idx" ON "stock_reservations"("productId");
CREATE INDEX "stock_reservations_orderId_idx" ON "stock_reservations"("orderId");

-- Shortage allocation scan: active orders with open shortage for a product.
CREATE INDEX "stock_reservations_product_shortage_idx"
  ON "stock_reservations"("productId")
  WHERE "requiredQuantity" > "reservedQuantity";

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
