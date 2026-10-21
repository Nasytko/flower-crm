-- POS stage 1: working carts + Order channel/payment axes (no warehouse impact until confirm).

CREATE TYPE "OrderSource" AS ENUM ('BACKOFFICE', 'POS');
CREATE TYPE "OrderFulfillmentMode" AS ENUM ('WALK_IN', 'SCHEDULED');
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "PosCartStatus" AS ENUM ('OPEN', 'PARKED', 'CONFIRMED', 'CANCELLED');
CREATE TYPE "PosCartLineType" AS ENUM ('PRODUCT', 'SERVICE', 'BOUQUET_TEMPLATE', 'BOUQUET_CUSTOM', 'ASSEMBLED');
CREATE TYPE "PosPriceMode" AS ENUM ('ADDITIONAL', 'INCLUDED');

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "source" "OrderSource" NOT NULL DEFAULT 'BACKOFFICE',
  ADD COLUMN IF NOT EXISTS "fulfillmentMode" "OrderFulfillmentMode" NOT NULL DEFAULT 'SCHEDULED',
  ADD COLUMN IF NOT EXISTS "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

ALTER TABLE "orders" ALTER COLUMN "customerPhone" SET DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS "orders_idempotencyKey_key" ON "orders"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "orders_source_createdAt_idx" ON "orders"("source", "createdAt");

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "parentOrderItemId" TEXT,
  ADD COLUMN IF NOT EXISTS "priceMode" "PosPriceMode" NOT NULL DEFAULT 'ADDITIONAL',
  ADD COLUMN IF NOT EXISTS "recommendedUnitPrice" DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "priceOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lineDiscountType" "DiscountType",
  ADD COLUMN IF NOT EXISTS "lineDiscountValue" DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "lineDiscountAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "order_items_parentOrderItemId_idx" ON "order_items"("parentOrderItemId");

ALTER TABLE "order_items"
  DROP CONSTRAINT IF EXISTS "order_items_parentOrderItemId_fkey";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_parentOrderItemId_fkey"
  FOREIGN KEY ("parentOrderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_item_components"
  ADD COLUMN IF NOT EXISTS "priceMode" "PosPriceMode" NOT NULL DEFAULT 'ADDITIONAL',
  ADD COLUMN IF NOT EXISTS "unitSalePriceSnapshot" DECIMAL(12, 2);

CREATE TABLE IF NOT EXISTS "pos_carts" (
  "id" TEXT NOT NULL,
  "status" "PosCartStatus" NOT NULL DEFAULT 'OPEN',
  "ownerUserId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "discountType" "DiscountType",
  "discountValue" DECIMAL(12, 2),
  "discountAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "subtotal" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "parkedAt" TIMESTAMP(3),
  "parkedLabel" TEXT,
  "confirmIdempotencyKey" TEXT,
  "confirmedOrderId" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pos_carts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pos_carts_confirmIdempotencyKey_key" ON "pos_carts"("confirmIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pos_carts_confirmedOrderId_key" ON "pos_carts"("confirmedOrderId");
CREATE INDEX IF NOT EXISTS "pos_carts_ownerUserId_status_idx" ON "pos_carts"("ownerUserId", "status");
CREATE INDEX IF NOT EXISTS "pos_carts_status_updatedAt_idx" ON "pos_carts"("status", "updatedAt");

ALTER TABLE "pos_carts"
  DROP CONSTRAINT IF EXISTS "pos_carts_ownerUserId_fkey";
ALTER TABLE "pos_carts"
  ADD CONSTRAINT "pos_carts_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pos_carts"
  DROP CONSTRAINT IF EXISTS "pos_carts_confirmedOrderId_fkey";
ALTER TABLE "pos_carts"
  ADD CONSTRAINT "pos_carts_confirmedOrderId_fkey"
  FOREIGN KEY ("confirmedOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "pos_cart_lines" (
  "id" TEXT NOT NULL,
  "cartId" TEXT NOT NULL,
  "lineType" "PosCartLineType" NOT NULL,
  "productId" TEXT,
  "bouquetTemplateId" TEXT,
  "assembledBouquetId" TEXT,
  "parentLineId" TEXT,
  "priceMode" "PosPriceMode" NOT NULL DEFAULT 'ADDITIONAL',
  "nameSnapshot" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "recommendedUnitPrice" DECIMAL(12, 2) NOT NULL,
  "unitPrice" DECIMAL(12, 2) NOT NULL,
  "priceOverridden" BOOLEAN NOT NULL DEFAULT false,
  "priceOverrideReason" TEXT,
  "priceOverriddenByUserId" TEXT,
  "lineDiscountType" "DiscountType",
  "lineDiscountValue" DECIMAL(12, 2),
  "lineDiscountAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "lineSubtotal" DECIMAL(12, 2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pos_cart_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pos_cart_lines_cartId_sortOrder_idx" ON "pos_cart_lines"("cartId", "sortOrder");
CREATE INDEX IF NOT EXISTS "pos_cart_lines_assembledBouquetId_idx" ON "pos_cart_lines"("assembledBouquetId");
CREATE INDEX IF NOT EXISTS "pos_cart_lines_parentLineId_idx" ON "pos_cart_lines"("parentLineId");

ALTER TABLE "pos_cart_lines"
  DROP CONSTRAINT IF EXISTS "pos_cart_lines_cartId_fkey";
ALTER TABLE "pos_cart_lines"
  ADD CONSTRAINT "pos_cart_lines_cartId_fkey"
  FOREIGN KEY ("cartId") REFERENCES "pos_carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pos_cart_lines"
  DROP CONSTRAINT IF EXISTS "pos_cart_lines_productId_fkey";
ALTER TABLE "pos_cart_lines"
  ADD CONSTRAINT "pos_cart_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pos_cart_lines"
  DROP CONSTRAINT IF EXISTS "pos_cart_lines_bouquetTemplateId_fkey";
ALTER TABLE "pos_cart_lines"
  ADD CONSTRAINT "pos_cart_lines_bouquetTemplateId_fkey"
  FOREIGN KEY ("bouquetTemplateId") REFERENCES "bouquets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pos_cart_lines"
  DROP CONSTRAINT IF EXISTS "pos_cart_lines_assembledBouquetId_fkey";
ALTER TABLE "pos_cart_lines"
  ADD CONSTRAINT "pos_cart_lines_assembledBouquetId_fkey"
  FOREIGN KEY ("assembledBouquetId") REFERENCES "assembled_bouquets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pos_cart_lines"
  DROP CONSTRAINT IF EXISTS "pos_cart_lines_parentLineId_fkey";
ALTER TABLE "pos_cart_lines"
  ADD CONSTRAINT "pos_cart_lines_parentLineId_fkey"
  FOREIGN KEY ("parentLineId") REFERENCES "pos_cart_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pos_cart_lines"
  DROP CONSTRAINT IF EXISTS "pos_cart_lines_priceOverriddenByUserId_fkey";
ALTER TABLE "pos_cart_lines"
  ADD CONSTRAINT "pos_cart_lines_priceOverriddenByUserId_fkey"
  FOREIGN KEY ("priceOverriddenByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "pos_cart_line_components" (
  "id" TEXT NOT NULL,
  "lineId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productNameSnapshot" TEXT NOT NULL,
  "productTypeSnapshot" "ProductType" NOT NULL,
  "unitSnapshot" "Unit" NOT NULL DEFAULT 'PIECE',
  "quantity" INTEGER NOT NULL,
  "unitSalePriceSnapshot" DECIMAL(12, 2),
  "priceMode" "PosPriceMode" NOT NULL DEFAULT 'ADDITIONAL',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cart_line_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pos_cart_line_components_lineId_idx" ON "pos_cart_line_components"("lineId");
CREATE INDEX IF NOT EXISTS "pos_cart_line_components_productId_idx" ON "pos_cart_line_components"("productId");

ALTER TABLE "pos_cart_line_components"
  DROP CONSTRAINT IF EXISTS "pos_cart_line_components_lineId_fkey";
ALTER TABLE "pos_cart_line_components"
  ADD CONSTRAINT "pos_cart_line_components_lineId_fkey"
  FOREIGN KEY ("lineId") REFERENCES "pos_cart_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pos_cart_line_components"
  DROP CONSTRAINT IF EXISTS "pos_cart_line_components_productId_fkey";
ALTER TABLE "pos_cart_line_components"
  ADD CONSTRAINT "pos_cart_line_components_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
