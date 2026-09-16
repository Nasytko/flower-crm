import { InventoryStatus } from '@erp/shared';
import type { PrismaClient } from '@erp/database';

type PrismaLike = {
  inventorySession: {
    updateMany: (args: {
      where: { status: InventoryStatus };
      data: { status: InventoryStatus; cancelledAt: Date };
    }) => Promise<unknown>;
  };
};

/** Clears leftover warehouse freezes so live suites do not block each other. */
export async function cancelLeftoverInventories(prisma: PrismaLike): Promise<void> {
  await prisma.inventorySession.updateMany({
    where: { status: InventoryStatus.IN_PROGRESS },
    data: { status: InventoryStatus.CANCELLED, cancelledAt: new Date() },
  });
}

/** Creates an active supplier for live/concurrency test suites. */
export async function createTestSupplier(
  prisma: Pick<PrismaClient, 'supplier'>,
  name: string,
): Promise<{ id: string; name: string }> {
  return prisma.supplier.create({
    data: { name, isActive: true },
  });
}

/** Removes test suppliers after related supplies are deleted. */
export async function deleteTestSuppliers(
  prisma: Pick<PrismaClient, 'supplier'>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await prisma.supplier.deleteMany({ where: { id: { in: ids } } });
}
