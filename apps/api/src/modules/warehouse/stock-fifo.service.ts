import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@erp/database';
import { UNKNOWN_LOT_SHELF_DAYS } from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import { isLotSuitableForDate } from './lot-suitability';

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

export type LotPickMode = 'FIFO' | 'FEFO';

/**
 * Physical lot consumption and return.
 *
 * - FEFO (default for flower assembly): usableUntil ASC NULLS LAST, then receivedAt.
 *   Cost is taken from the physically selected lots (not a separate FIFO cost layer).
 * - FIFO: receivedAt ASC (write-offs / legacy paths).
 *
 * Null usableUntil is NOT infinite: see lot-suitability.ts / docs/lot-suitability.md.
 */
@Injectable()
export class StockFifoService {
  async consumeLots(
    tx: Tx,
    productId: string,
    quantity: number,
    options: {
      requireFullCoverage: boolean;
      mode?: LotPickMode;
      /** When set, only lots effectively usable on/after this date. */
      requiredUsableUntil?: Date | null;
    },
  ): Promise<FifoConsumeResult> {
    if (quantity <= 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Количество списания должно быть положительным',
        { quantity },
        HttpStatus.BAD_REQUEST,
      );
    }

    const mode = options.mode ?? 'FEFO';
    const lots = await this.lockLots(tx, productId, mode);
    const needDate = options.requiredUsableUntil ?? null;

    let remainingToTake = quantity;
    const allocations: FifoLotAllocation[] = [];
    let knownCost = new Prisma.Decimal(0);
    let hasUncosted = false;

    for (const lot of lots) {
      if (remainingToTake <= 0) break;
      if (
        needDate &&
        !isLotSuitableForDate(
          { usableUntil: lot.usableUntil, receivedAt: lot.receivedAt },
          needDate,
        )
      ) {
        continue;
      }
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
        'Недостаточно партий для операции',
        { productId, remaining: remainingToTake, requested: quantity },
        HttpStatus.CONFLICT,
      );
    }

    return { allocations, knownCost, hasUncosted };
  }

  /** Return stems to original lots (disassemble). Does not invent a supplier receipt. */
  async returnToLots(
    tx: Tx,
    returns: Array<{ stockLotId: string; quantity: number }>,
  ): Promise<void> {
    const sorted = [...returns].sort((a, b) => a.stockLotId.localeCompare(b.stockLotId));
    for (const row of sorted) {
      if (row.quantity <= 0) continue;
      const lots = await tx.$queryRaw<
        Array<{ id: string; remainingQuantity: number; receivedQuantity: number }>
      >`
        SELECT id, "remainingQuantity", "receivedQuantity"
        FROM stock_lots
        WHERE id = ${row.stockLotId}
        FOR UPDATE
      `;
      const lot = lots[0];
      if (!lot) {
        throw new AppError(
          'STOCK_LOT_NOT_FOUND',
          'Партия для возврата не найдена',
          { stockLotId: row.stockLotId },
          HttpStatus.CONFLICT,
        );
      }
      const next = lot.remainingQuantity + row.quantity;
      if (next > lot.receivedQuantity) {
        throw new AppError(
          'STOCK_LOT_OVERFLOW',
          'Нельзя вернуть в партию больше, чем было получено',
          {
            stockLotId: row.stockLotId,
            remainingQuantity: lot.remainingQuantity,
            receivedQuantity: lot.receivedQuantity,
            returning: row.quantity,
          },
          HttpStatus.CONFLICT,
        );
      }
      await tx.stockLot.update({
        where: { id: lot.id },
        data: { remainingQuantity: next },
      });
    }
  }

  /**
   * Suitable unassembled quantity for promising on fulfillmentDate.
   * Null usableUntil → receivedAt::date + UNKNOWN_LOT_SHELF_DAYS (not infinite).
   */
  async suitableRemainingQuantity(
    tx: Tx,
    productId: string,
    fulfillmentDate: Date,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ qty: bigint | number }>>`
      SELECT COALESCE(SUM("remainingQuantity"), 0) AS qty
      FROM stock_lots
      WHERE "productId" = ${productId}
        AND "remainingQuantity" > 0
        AND "reversedAt" IS NULL
        AND COALESCE(
          "usableUntil",
          (("receivedAt" AT TIME ZONE 'UTC')::date + ${UNKNOWN_LOT_SHELF_DAYS}::int)
        ) >= ${fulfillmentDate}::date
    `;
    return Number(rows[0]?.qty ?? 0);
  }

  private async lockLots(
    tx: Tx,
    productId: string,
    mode: LotPickMode,
  ): Promise<
    Array<{
      id: string;
      remainingQuantity: number;
      unitPurchasePrice: Prisma.Decimal | null;
      usableUntil: Date | null;
      receivedAt: Date;
    }>
  > {
    if (mode === 'FIFO') {
      return tx.$queryRaw`
        SELECT id, "remainingQuantity", "unitPurchasePrice", "usableUntil", "receivedAt"
        FROM stock_lots
        WHERE "productId" = ${productId}
          AND "remainingQuantity" > 0
          AND "reversedAt" IS NULL
        ORDER BY "receivedAt" ASC, "createdAt" ASC, id ASC
        FOR UPDATE
      `;
    }

    return tx.$queryRaw`
      SELECT id, "remainingQuantity", "unitPurchasePrice", "usableUntil", "receivedAt"
      FROM stock_lots
      WHERE "productId" = ${productId}
        AND "remainingQuantity" > 0
        AND "reversedAt" IS NULL
      ORDER BY
        CASE WHEN "usableUntil" IS NULL THEN 1 ELSE 0 END ASC,
        "usableUntil" ASC NULLS LAST,
        "receivedAt" ASC,
        "createdAt" ASC,
        id ASC
      FOR UPDATE
    `;
  }
}
