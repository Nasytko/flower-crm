-- Drop commercial "order source" (IN_STORE/PHONE/…) from ERP orders.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "source";
DROP TYPE IF EXISTS "OrderSource";
