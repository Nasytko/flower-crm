-- Flower product attributes (inline dictionary) + product images.

CREATE TYPE "ProductAttrKind" AS ENUM (
  'FLOWER_KIND',
  'FLOWER_FORM',
  'VARIETY',
  'COLOR',
  'ORIGIN'
);

CREATE TABLE "product_attribute_values" (
  "id" TEXT NOT NULL,
  "kind" "ProductAttrKind" NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "parentKey" TEXT NOT NULL DEFAULT '',
  "parentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_attribute_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_attribute_values_kind_parentKey_normalizedName_key"
  ON "product_attribute_values"("kind", "parentKey", "normalizedName");

CREATE INDEX "product_attribute_values_kind_parentKey_idx"
  ON "product_attribute_values"("kind", "parentKey");

CREATE INDEX "product_attribute_values_parentId_idx"
  ON "product_attribute_values"("parentId");

ALTER TABLE "product_attribute_values"
  ADD CONSTRAINT "product_attribute_values_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "product_attribute_values"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "product_images" (
  "id" TEXT NOT NULL,
  "productId" TEXT,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_images_productId_sortOrder_idx"
  ON "product_images"("productId", "sortOrder");

CREATE INDEX "product_images_createdAt_idx"
  ON "product_images"("createdAt");

ALTER TABLE "products"
  ADD COLUMN "flowerKindId" TEXT,
  ADD COLUMN "flowerFormId" TEXT,
  ADD COLUMN "varietyId" TEXT,
  ADD COLUMN "colorId" TEXT,
  ADD COLUMN "originId" TEXT,
  ADD COLUMN "stemLengthCm" INTEGER,
  ADD COLUMN "primaryImageId" TEXT;

CREATE UNIQUE INDEX "products_primaryImageId_key" ON "products"("primaryImageId");
CREATE INDEX "products_flowerKindId_idx" ON "products"("flowerKindId");
CREATE INDEX "products_varietyId_idx" ON "products"("varietyId");
CREATE INDEX "products_colorId_idx" ON "products"("colorId");

ALTER TABLE "products"
  ADD CONSTRAINT "products_flowerKindId_fkey"
  FOREIGN KEY ("flowerKindId") REFERENCES "product_attribute_values"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_flowerFormId_fkey"
  FOREIGN KEY ("flowerFormId") REFERENCES "product_attribute_values"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_varietyId_fkey"
  FOREIGN KEY ("varietyId") REFERENCES "product_attribute_values"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_colorId_fkey"
  FOREIGN KEY ("colorId") REFERENCES "product_attribute_values"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_originId_fkey"
  FOREIGN KEY ("originId") REFERENCES "product_attribute_values"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_images"
  ADD CONSTRAINT "product_images_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_primaryImageId_fkey"
  FOREIGN KEY ("primaryImageId") REFERENCES "product_images"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
