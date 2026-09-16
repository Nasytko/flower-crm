import { InventoryStatus } from '@erp/shared';

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
