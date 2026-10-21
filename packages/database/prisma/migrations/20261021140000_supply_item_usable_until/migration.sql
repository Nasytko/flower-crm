-- Optional usableUntil on supply lines (copied to stock_lots on post).
ALTER TABLE "supply_items"
  ADD COLUMN IF NOT EXISTS "usableUntil" DATE;
