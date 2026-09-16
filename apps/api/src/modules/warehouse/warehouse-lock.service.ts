import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@erp/database';
import { InventoryStatus } from '@erp/shared';
import { AppError } from '../../common/errors/app-error';

type Tx = Prisma.TransactionClient;

function inventoryNumberLabel(number: number): string {
  return `INV-${String(number).padStart(6, '0')}`;
}

/**
 * Transaction-scoped warehouse advisory lock key.
 * Serialize inventory start/complete and physical stock / reservation mutations.
 * Do NOT use for ordinary reads.
 */
export const WAREHOUSE_ADVISORY_LOCK_KEY = 482_910_374_651;

@Injectable()
export class WarehouseLockService {
  /**
   * Global lock order (deadlock-safe) for ALL warehouse-affecting flows:
   * 1. warehouse advisory xact lock
   * 2. business document row (FOR UPDATE / CAS)
   * 3. ProductStock rows sorted by productId ASC
   * 4. StockReservation rows (under locked products)
   * 5. StockLot rows FIFO (receivedAt, createdAt, id)
   * 6. StockMovement + allocations
   */
  async acquireWarehouseLock(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WAREHOUSE_ADVISORY_LOCK_KEY})`;
  }

  async findActiveInventory(tx: Tx): Promise<{ id: string; number: number } | null> {
    return tx.inventorySession.findFirst({
      where: { status: InventoryStatus.IN_PROGRESS },
      select: { id: true, number: true },
    });
  }

  /** Reject physical stock mutations while a stocktake is in progress. */
  async assertNoActiveInventory(tx: Tx): Promise<void> {
    const active = await this.findActiveInventory(tx);
    if (active) {
      throw new AppError(
        'INVENTORY_IN_PROGRESS',
        `Идёт инвентаризация ${inventoryNumberLabel(active.number)}. Операции, изменяющие остатки, временно недоступны.`,
        {
          inventoryId: active.id,
          inventoryNumber: active.number,
          numberLabel: inventoryNumberLabel(active.number),
        },
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Acquire lock then assert — use at the start of stock-mutating transactions. */
  async beginStockMutation(tx: Tx): Promise<void> {
    await this.acquireWarehouseLock(tx);
    await this.assertNoActiveInventory(tx);
  }
}
