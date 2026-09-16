import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';

type Tx = Prisma.TransactionClient;

export type FifoLotAllocation = {
  stockLotId: string;
  quantity: number;
  unitPurchasePrice: Prisma.Decimal | null;
};

export type FifoConsumeResult = {
  allocations: FifoLotAllocation[];
  /** Sum of quantity × price for costed lots only. */
  knownCost: Prisma.Decimal;
  hasUncosted: boolean;
};

/**
 * Shared FIFO lot consumption (write-off, inventory shortage, order SALE).
 * Caller must already hold warehouse advisory lock and ProductStock FOR UPDATE.
 */
@Injectable()
export class StockFifoService {
  async consumeLots(
    tx: Tx,
    productId: string,
    quantity: number,
    options: { requireFullCoverage: boolean },
  ): Promise<FifoConsumeResult> {
    if (quantity <= 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Количество списания должно быть положительным',
        { quantity },
        HttpStatus.BAD_REQUEST,
      );
    }

    const lots = await tx.$queryRaw<
      Array<{
        id: string;
        remainingQuantity: number;
        unitPurchasePrice: Prisma.Decimal | null;
      }>
    >`
      SELECT id, "remainingQuantity", "unitPurchasePrice"
      FROM stock_lots
      WHERE "productId" = ${productId}
        AND "remainingQuantity" > 0
        AND "reversedAt" IS NULL
      ORDER BY "receivedAt" ASC, "createdAt" ASC, id ASC
      FOR UPDATE
    `;

    let remainingToTake = quantity;
    const allocations: FifoLotAllocation[] = [];
    let knownCost = new Prisma.Decimal(0);
    let hasUncosted = false;

    for (const lot of lots) {
      if (remainingToTake <= 0) break;
      const take = Math.min(lot.remainingQuantity, remainingToTake);
      if (take <= 0) continue;
      await tx.stockLot.update({
        where: { id: lot.id },
        data: { remainingQuantity: lot.remainingQuantity - take },
      });
      allocations.push({
        stockLotId: lot.id,
        quantity: take,
        unitPurchasePrice: lot.unitPurchasePrice,
      });
      if (lot.unitPurchasePrice == null) {
        hasUncosted = true;
      } else {
        knownCost = knownCost.plus(lot.unitPurchasePrice.mul(take));
      }
      remainingToTake -= take;
    }

    if (remainingToTake > 0 && options.requireFullCoverage) {
      throw new AppError(
        'INSUFFICIENT_STOCK',
        'Недостаточно партий для списания',
        { productId, remaining: remainingToTake, requested: quantity },
        HttpStatus.CONFLICT,
      );
    }

    return { allocations, knownCost, hasUncosted };
  }
}
