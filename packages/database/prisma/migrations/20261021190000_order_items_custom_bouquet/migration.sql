-- POS custom / assembled bouquets are OrderItemType.BOUQUET with bouquetId NULL
-- (no template). Relax the legacy check that required a bouquet template FK.
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_type_refs";
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_type_refs" CHECK (
  ("itemType" = 'PRODUCT' AND "productId" IS NOT NULL AND "bouquetId" IS NULL)
  OR ("itemType" = 'BOUQUET' AND "productId" IS NULL)
);
