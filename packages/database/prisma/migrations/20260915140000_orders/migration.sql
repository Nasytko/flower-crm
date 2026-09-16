-- Phase 7: Orders core (commercial document). Does NOT touch warehouse stock.

CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'READY', 'COMPLETED', 'CANCELLED');
CREATE TYPE "OrderSource" AS ENUM ('IN_STORE', 'PHONE', 'INSTAGRAM', 'WEBSITE', 'OTHER');
CREATE TYPE "FulfillmentType" AS ENUM ('PICKUP', 'DELIVERY');
CREATE TYPE "OrderItemType" AS ENUM ('PRODUCT', 'BOUQUET');
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED');

CREATE TABLE "order_daily_counters" (
    "businessDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_daily_counters_pkey" PRIMARY KEY ("businessDate"),
    CONSTRAINT "order_daily_counters_last_number_positive" CHECK ("lastNumber" > 0)
);

CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "numberBusinessDate" DATE NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "source" "OrderSource" NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "fulfillmentType" "FulfillmentType" NOT NULL,
    "fulfillmentDate" DATE NOT NULL,
    "fulfillmentTimeFrom" VARCHAR(5),
    "fulfillmentTimeTo" VARCHAR(5),
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "deliveryAddressText" TEXT,
    "deliveryLatitude" DECIMAL(9,6),
    "deliveryLongitude" DECIMAL(9,6),
    "deliveryProvider" TEXT,
    "deliveryProviderPlaceId" TEXT,
    "deliveryComment" TEXT,
    "orderComment" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountType" "DiscountType",
    "discountValue" DECIMAL(12,2),
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "readyAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "orders_subtotal_nonneg" CHECK ("subtotal" >= 0),
    CONSTRAINT "orders_discount_amount_nonneg" CHECK ("discountAmount" >= 0),
    CONSTRAINT "orders_total_nonneg" CHECK ("total" >= 0),
    CONSTRAINT "orders_version_positive" CHECK ("version" > 0),
    CONSTRAINT "orders_time_pair" CHECK (
      ("fulfillmentTimeTo" IS NULL) OR ("fulfillmentTimeFrom" IS NOT NULL)
    ),
    CONSTRAINT "orders_time_order" CHECK (
      ("fulfillmentTimeFrom" IS NULL) OR ("fulfillmentTimeTo" IS NULL)
      OR ("fulfillmentTimeTo" >= "fulfillmentTimeFrom")
    ),
    CONSTRAINT "orders_delivery_address" CHECK (
      ("fulfillmentType" = 'PICKUP' AND "deliveryAddressText" IS NULL)
      OR ("fulfillmentType" = 'DELIVERY' AND "deliveryAddressText" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "orders_number_key" ON "orders"("number");
CREATE INDEX "orders_fulfillmentDate_status_idx" ON "orders"("fulfillmentDate", "status");
CREATE INDEX "orders_fulfillmentDate_fulfillmentType_idx" ON "orders"("fulfillmentDate", "fulfillmentType");
CREATE INDEX "orders_fulfillmentDate_fulfillmentTimeFrom_idx" ON "orders"("fulfillmentDate", "fulfillmentTimeFrom");
CREATE INDEX "orders_status_idx" ON "orders"("status");
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

ALTER TABLE "orders" ADD CONSTRAINT "orders_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemType" "OrderItemType" NOT NULL,
    "productId" TEXT,
    "bouquetId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineSubtotal" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "order_items_unit_price_nonneg" CHECK ("unitPrice" >= 0),
    CONSTRAINT "order_items_line_subtotal_nonneg" CHECK ("lineSubtotal" >= 0),
    CONSTRAINT "order_items_type_refs" CHECK (
      ("itemType" = 'PRODUCT' AND "productId" IS NOT NULL AND "bouquetId" IS NULL)
      OR ("itemType" = 'BOUQUET' AND "bouquetId" IS NOT NULL AND "productId" IS NULL)
    )
);

CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");
CREATE INDEX "order_items_bouquetId_idx" ON "order_items"("bouquetId");

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bouquetId_fkey"
  FOREIGN KEY ("bouquetId") REFERENCES "bouquets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "order_item_components" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "productTypeSnapshot" "ProductType" NOT NULL,
    "unitSnapshot" "Unit" NOT NULL,
    "quantityPerItem" INTEGER NOT NULL,
    "totalQuantity" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_item_components_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_item_components_qty_per_positive" CHECK ("quantityPerItem" > 0),
    CONSTRAINT "order_item_components_total_positive" CHECK ("totalQuantity" > 0)
);

CREATE INDEX "order_item_components_orderItemId_idx" ON "order_item_components"("orderItemId");
CREATE INDEX "order_item_components_productId_idx" ON "order_item_components"("productId");

ALTER TABLE "order_item_components" ADD CONSTRAINT "order_item_components_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_item_components" ADD CONSTRAINT "order_item_components_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
