import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';

type Tx = Prisma.TransactionClient;

/**
 * Mutates ProductStock aggregates consistently with movements.
 * Source of truth remains movements + lots + AssembledBouquetComponent*.
 */
@Injectable()
export class StockBalanceService {
  async adjustOnHand(
    tx: Tx,
    productId: string,
    delta: number,
  ): Promise<{ quantityOnHand: number; quantityReserved: number; quantityInBouquets: number }> {
    const stock = await tx.productStock.findUnique({ where: { productId } });
    if (!stock) {
      throw new AppError(
        'STOCK_NOT_SUPPORTED',
        'Складская запись отсутствует',
        { productId },
        HttpStatus.CONFLICT,
      );
    }
    const nextOnHand = stock.quantityOnHand + delta;
    if (nextOnHand < 0 || stock.quantityReserved > nextOnHand) {
      throw new AppError(
        'INSUFFICIENT_STOCK',
        'Недостаточно свободных цветов на складе',
        {
          productId,
          quantityOnHand: stock.quantityOnHand,
          quantityReserved: stock.quantityReserved,
          delta,
        },
        HttpStatus.CONFLICT,
      );
    }
    return tx.productStock.update({
      where: { productId },
      data: { quantityOnHand: nextOnHand },
    });
  }

  async adjustInBouquets(
    tx: Tx,
    productId: string,
    delta: number,
  ): Promise<{ quantityOnHand: number; quantityReserved: number; quantityInBouquets: number }> {
    const stock = await tx.productStock.findUnique({ where: { productId } });
    if (!stock) {
      throw new AppError(
        'STOCK_NOT_SUPPORTED',
        'Складская запись отсутствует',
        { productId },
        HttpStatus.CONFLICT,
      );
    }
    const next = stock.quantityInBouquets + delta;
    if (next < 0) {
      throw new AppError(
        'STOCK_IN_BOUQUETS_INVARIANT',
        'Нарушение учёта цветов в готовых букетах',
        {
          productId,
          quantityInBouquets: stock.quantityInBouquets,
          delta,
        },
        HttpStatus.CONFLICT,
      );
    }
    return tx.productStock.update({
      where: { productId },
      data: { quantityInBouquets: next },
    });
  }

  /**
   * Assert aggregates match derived sources (for tests / diagnostics).
   * reserved = Σ StockReservation
   * inBouquets = Σ AssembledBouquetComponent.quantity where status=ASSEMBLED
   */
  async assertConsistency(tx: Tx, productId: string): Promise<void> {
    const stock = await tx.productStock.findUniqueOrThrow({ where: { productId } });
    const resSum = await tx.stockReservation.aggregate({
      where: { productId },
      _sum: { reservedQuantity: true },
    });
    const reserved = resSum._sum.reservedQuantity ?? 0;
    if (reserved !== stock.quantityReserved) {
      throw new AppError(
        'STOCK_AGGREGATE_MISMATCH',
        'Резерв не совпадает с суммой плановых резервов',
        { productId, aggregate: stock.quantityReserved, derived: reserved },
        HttpStatus.CONFLICT,
      );
    }

    const bouquetSum = await tx.$queryRaw<Array<{ qty: bigint | number }>>`
      SELECT COALESCE(SUM(c.quantity), 0) AS qty
      FROM assembled_bouquet_components c
      INNER JOIN assembled_bouquets b ON b.id = c."assembledBouquetId"
      WHERE c."productId" = ${productId}
        AND b.status = 'ASSEMBLED'
    `;
    const inBouquets = Number(bouquetSum[0]?.qty ?? 0);
    if (inBouquets !== stock.quantityInBouquets) {
      throw new AppError(
        'STOCK_AGGREGATE_MISMATCH',
        'Остаток в букетах не совпадает с составом изделий',
        { productId, aggregate: stock.quantityInBouquets, derived: inBouquets },
        HttpStatus.CONFLICT,
      );
    }

    const lotSum = await tx.stockLot.aggregate({
      where: { productId, reversedAt: null },
      _sum: { remainingQuantity: true },
    });
    const lotsRemaining = lotSum._sum.remainingQuantity ?? 0;
    if (lotsRemaining !== stock.quantityOnHand) {
      throw new AppError(
        'STOCK_AGGREGATE_MISMATCH',
        'Остаток на полке не совпадает с партиями',
        { productId, onHand: stock.quantityOnHand, lotsRemaining },
        HttpStatus.CONFLICT,
      );
    }
  }

  moneyOrNull(value: Prisma.Decimal | null | undefined): string | null {
    if (value == null) return null;
    return value.toFixed(2);
  }
}
