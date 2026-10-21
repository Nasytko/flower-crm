import { Injectable } from '@nestjs/common';
import {
  AssembledBouquetStatus,
  OrderStatus,
  ProductType,
  type WarehouseStockDetailDto,
  type WarehouseStockRowDto,
} from '@erp/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isoDateFromDb } from '../orders/business-time';

@Injectable()
export class WarehouseStockService {
  constructor(private readonly prisma: PrismaService) {}

  async listStockRows(): Promise<WarehouseStockRowDto[]> {
    const products = await this.prisma.product.findMany({
      where: { type: ProductType.FLOWER, isActive: true },
      include: { stock: true },
      orderBy: { name: 'asc' },
    });

    const deficits = await this.prisma.$queryRaw<
      Array<{ productId: string; deficit: bigint | number }>
    >`
      SELECT r."productId",
             COALESCE(SUM(GREATEST(r."requiredQuantity" - r."reservedQuantity", 0)), 0) AS deficit
      FROM stock_reservations r
      INNER JOIN orders o ON o.id = r."orderId"
      WHERE o.status IN ('NEW', 'IN_PROGRESS', 'READY')
      GROUP BY r."productId"
    `;
    const deficitMap = new Map(deficits.map((d) => [d.productId, Number(d.deficit)]));

    return products.map((p) => {
      const onHand = p.stock?.quantityOnHand ?? 0;
      const reserved = p.stock?.quantityReserved ?? 0;
      const inBouquets = p.stock?.quantityInBouquets ?? 0;
      return {
        productId: p.id,
        productName: p.name,
        availableQuantity: onHand - reserved,
        reservedQuantity: reserved,
        quantityInBouquets: inBouquets,
        totalPhysical: onHand + inBouquets,
        deficitQuantity: deficitMap.get(p.id) ?? 0,
      };
    });
  }

  async getStockDetail(productId: string): Promise<WarehouseStockDetailDto | null> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, type: ProductType.FLOWER },
      include: { stock: true },
    });
    if (!product) return null;

    const onHand = product.stock?.quantityOnHand ?? 0;
    const reserved = product.stock?.quantityReserved ?? 0;
    const inBouquets = product.stock?.quantityInBouquets ?? 0;

    const reserves = await this.prisma.stockReservation.findMany({
      where: {
        productId,
        order: { status: { in: [OrderStatus.NEW, OrderStatus.IN_PROGRESS, OrderStatus.READY] } },
      },
      include: {
        order: {
          select: {
            id: true,
            number: true,
            fulfillmentDate: true,
            fulfillmentTimeFrom: true,
          },
        },
      },
      orderBy: [{ order: { fulfillmentDate: 'asc' } }, { order: { number: 'asc' } }],
    });

    const bouquetComps = await this.prisma.assembledBouquetComponent.findMany({
      where: {
        productId,
        bouquet: { status: AssembledBouquetStatus.ASSEMBLED },
      },
      include: {
        bouquet: {
          include: { order: { select: { id: true, number: true } } },
        },
      },
      orderBy: { bouquet: { assembledAt: 'desc' } },
    });

    const lots = await this.prisma.stockLot.findMany({
      where: { productId, remainingQuantity: { gt: 0 }, reversedAt: null },
      orderBy: [{ usableUntil: 'asc' }, { receivedAt: 'asc' }],
    });

    const deficitQuantity = reserves.reduce(
      (sum, r) => sum + Math.max(r.requiredQuantity - r.reservedQuantity, 0),
      0,
    );

    return {
      productId: product.id,
      productName: product.name,
      availableQuantity: onHand - reserved,
      reservedQuantity: reserved,
      quantityInBouquets: inBouquets,
      totalPhysical: onHand + inBouquets,
      deficitQuantity,
      reserves: reserves.map((r) => ({
        orderId: r.order.id,
        orderNumber: r.order.number,
        fulfillmentDate: isoDateFromDb(r.order.fulfillmentDate),
        fulfillmentTimeFrom: r.order.fulfillmentTimeFrom,
        requiredQuantity: r.requiredQuantity,
        reservedQuantity: r.reservedQuantity,
        shortageQuantity: Math.max(r.requiredQuantity - r.reservedQuantity, 0),
      })),
      bouquets: bouquetComps.map((c) => ({
        assembledBouquetId: c.bouquet.id,
        number: c.bouquet.number,
        orderId: c.bouquet.orderId,
        orderNumber: c.bouquet.order?.number ?? null,
        quantity: c.quantity,
        assembledAt: c.bouquet.assembledAt.toISOString(),
        status: c.bouquet.status as AssembledBouquetStatus,
        nameSnapshot: c.bouquet.nameSnapshot,
      })),
      freeLots: lots.map((l) => ({
        stockLotId: l.id,
        remainingQuantity: l.remainingQuantity,
        unitPurchasePrice: l.unitPurchasePrice?.toFixed(2) ?? null,
        receivedAt: l.receivedAt.toISOString(),
        usableUntil: l.usableUntil ? isoDateFromDb(l.usableUntil) : null,
      })),
    };
  }
}
