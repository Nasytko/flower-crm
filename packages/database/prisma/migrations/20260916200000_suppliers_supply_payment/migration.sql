-- Suppliers directory + supply payment tracking

CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "comment" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");
CREATE INDEX "suppliers_isActive_name_idx" ON "suppliers"("isActive", "name");

-- Seed suppliers from distinct free-text names (and a fallback for blanks).
INSERT INTO "suppliers" ("id", "name", "isActive", "createdAt", "updatedAt")
SELECT
  'sup_' || md5(lower(trim(s."supplierName"))),
  trim(s."supplierName"),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT trim("supplierName") AS "supplierName"
  FROM "supplies"
  WHERE "supplierName" IS NOT NULL AND length(trim("supplierName")) > 0
) s
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "suppliers" ("id", "name", "isActive", "createdAt", "updatedAt")
SELECT
  'supplier_unspecified_default',
  'Не указан',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "suppliers" WHERE "name" = 'Не указан');

ALTER TABLE "supplies" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "supplies" ADD COLUMN "paymentDueDate" DATE;
ALTER TABLE "supplies" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "supplies" ADD COLUMN "paidByUserId" TEXT;

UPDATE "supplies" s
SET "supplierId" = sp."id"
FROM "suppliers" sp
WHERE s."supplierName" IS NOT NULL
  AND length(trim(s."supplierName")) > 0
  AND lower(trim(s."supplierName")) = lower(sp."name");

UPDATE "supplies"
SET "supplierId" = (SELECT "id" FROM "suppliers" WHERE "name" = 'Не указан' LIMIT 1)
WHERE "supplierId" IS NULL;

UPDATE "supplies"
SET "supplierName" = coalesce(nullif(trim("supplierName"), ''), 'Не указан')
WHERE "supplierName" IS NULL OR length(trim("supplierName")) = 0;

ALTER TABLE "supplies" ALTER COLUMN "supplierId" SET NOT NULL;
ALTER TABLE "supplies" ALTER COLUMN "supplierName" SET NOT NULL;

CREATE INDEX "supplies_supplierId_idx" ON "supplies"("supplierId");
CREATE INDEX "supplies_paymentDueDate_idx" ON "supplies"("paymentDueDate");
CREATE INDEX "supplies_paidAt_idx" ON "supplies"("paidAt");

ALTER TABLE "supplies"
  ADD CONSTRAINT "supplies_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplies"
  ADD CONSTRAINT "supplies_paidByUserId_fkey"
  FOREIGN KEY ("paidByUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
