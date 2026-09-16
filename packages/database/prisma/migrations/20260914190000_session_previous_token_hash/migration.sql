-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "previousTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_previousTokenHash_key" ON "sessions"("previousTokenHash");
