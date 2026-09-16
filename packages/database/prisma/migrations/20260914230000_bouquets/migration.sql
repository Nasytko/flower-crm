-- Phase 6: Bouquets as reusable recipes (not stock)

CREATE TABLE "bouquets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "salePrice" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bouquets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bouquets_isActive_idx" ON "bouquets"("isActive");
CREATE INDEX "bouquets_name_idx" ON "bouquets"("name");
CREATE INDEX "bouquets_isActive_name_idx" ON "bouquets"("isActive", "name");

ALTER TABLE "bouquets"
  ADD CONSTRAINT "bouquets_salePrice_nonneg" CHECK ("salePrice" >= 0);

ALTER TABLE "bouquets"
  ADD CONSTRAINT "bouquets_version_positive" CHECK ("version" > 0);

CREATE TABLE "bouquet_items" (
    "id" TEXT NOT NULL,
    "bouquetId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bouquet_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bouquet_items_bouquetId_productId_key" ON "bouquet_items"("bouquetId", "productId");
CREATE INDEX "bouquet_items_bouquetId_idx" ON "bouquet_items"("bouquetId");
CREATE INDEX "bouquet_items_productId_idx" ON "bouquet_items"("productId");

ALTER TABLE "bouquet_items"
  ADD CONSTRAINT "bouquet_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "bouquet_items"
  ADD CONSTRAINT "bouquet_items_bouquetId_fkey"
  FOREIGN KEY ("bouquetId") REFERENCES "bouquets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bouquet_items"
  ADD CONSTRAINT "bouquet_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
