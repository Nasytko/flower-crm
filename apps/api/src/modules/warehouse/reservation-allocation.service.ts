import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssembledBouquetStatus,
  AuditAction,
  OrderItemType,
  OrderStatus,
  ProductType,
  type OrderRequirementDto,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../../common/auth/auth.types';
import { StockFifoService } from './stock-fifo.service';
import { isLotSuitableForDate } from './lot-suitability';

type Tx = Prisma.TransactionClient;

export type RequirementMap = Map<
  string,
  { productId: string; productName: string; required: number }
>;

type ActiveOrderPriorityRow = {
  id: string;
  number: string;
  fulfillmentDate: Date;
  fulfillmentTimeFrom: string | null;
  createdAt: Date;
};

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.NEW,
  OrderStatus.IN_PROGRESS,
  OrderStatus.READY,
];

/**
 * Planned-reserve engine (soft allocation of unassembled on-hand).
 *
 * Formulas:
 *   available = onHand − reserved
 *   totalPhysical = onHand + inBouquets
 *
 * Preemption: full recompute by fulfillment priority — later orders lose reserve
 * to earlier ones. Suitability: do not promise lots whose usableUntil is before
 * the order fulfillment date (virtual FEFO capacity; lots are not pinned).
 *
 * Physical pick + costing at assembly use StockFifoService (FEFO pick / lot cost).
 */
@Injectable()
export class ReservationAllocationService {
  constructor(
    private readonly audit: AuditService,
    private readonly stockFifo: StockFifoService,
  ) {}

  /** Aggregate FLOWER requirements from order snapshot (not live Bouquet). */
  buildRequirementsFromItems(
    items: Array<{
      itemType: OrderItemType | string;
      productId: string | null;
      quantity: number;
      nameSnapshot: string;
      product?: { type: ProductType | string; name: string } | null;
      components: Array<{
        productId: string;
        productNameSnapshot: string;
        productTypeSnapshot: ProductType | string;
        totalQuantity: number;
      }>;
    }>,
  ): RequirementMap {
    const map: RequirementMap = new Map();

    const add = (productId: string, productName: string, qty: number) => {
      if (qty <= 0) return;
      const cur = map.get(productId);
      if (cur) {
        cur.required += qty;
      } else {
        map.set(productId, { productId, productName, required: qty });
      }
    };

    for (const item of items) {
      if (item.itemType === OrderItemType.PRODUCT || item.itemType === 'PRODUCT') {
        if (!item.productId) continue;
        const type = item.product?.type;
        if (type === ProductType.FLOWER || type === 'FLOWER') {
          add(item.productId, item.product?.name ?? item.nameSnapshot, item.quantity);
        }
        continue;
      }
      if (item.itemType === OrderItemType.BOUQUET || item.itemType === 'BOUQUET') {
        for (const c of item.components) {
          if (c.productTypeSnapshot === ProductType.FLOWER || c.productTypeSnapshot === 'FLOWER') {
            add(c.productId, c.productNameSnapshot, c.totalQuantity);
          }
        }
      }
    }
    return map;
  }

  async loadRequirementsForOrder(tx: Tx, orderId: string): Promise<RequirementMap> {
    const items = await tx.orderItem.findMany({
      where: { orderId },
      include: {
        product: { select: { type: true, name: true } },
        components: true,
      },
    });
    return this.buildRequirementsFromItems(items);
  }

  /**
   * Open (still unassembled / not direct-issued) FLOWER needs for planned reserve.
   * Subtracts actual composition of ASSEMBLED+ISSUED bouquets and direct-issued qty.
   */
  async loadOpenRequirementsForOrder(tx: Tx, orderId: string): Promise<RequirementMap> {
    const full = await this.loadRequirementsForOrder(tx, orderId);
    const consumed = new Map<string, number>();

    const bouquets = await tx.assembledBouquet.findMany({
      where: {
        orderId,
        status: { in: [AssembledBouquetStatus.ASSEMBLED, AssembledBouquetStatus.ISSUED] },
      },
      include: { components: true },
    });
    for (const b of bouquets) {
      for (const c of b.components) {
        consumed.set(c.productId, (consumed.get(c.productId) ?? 0) + c.quantity);
      }
    }

    const items = await tx.orderItem.findMany({
      where: { orderId },
      include: { product: { select: { type: true } } },
    });
    for (const item of items) {
      if (
        String(item.itemType) === OrderItemType.PRODUCT &&
        item.productId &&
        item.product?.type === ProductType.FLOWER &&
        item.quantityIssued > 0
      ) {
        consumed.set(item.productId, (consumed.get(item.productId) ?? 0) + item.quantityIssued);
      }
    }

    const open: RequirementMap = new Map();
    for (const [productId, req] of full) {
      const used = consumed.get(productId) ?? 0;
      const remaining = Math.max(req.required - used, 0);
      if (remaining > 0) {
        open.set(productId, {
          productId,
          productName: req.productName,
          required: remaining,
        });
      }
    }
    return open;
  }

  toRequirementDtos(
    requirements: RequirementMap,
    reservations: Array<{ productId: string; requiredQuantity: number; reservedQuantity: number }>,
  ): OrderRequirementDto[] {
    const reservedByProduct = new Map(reservations.map((r) => [r.productId, r] as const));
    const productIds = new Set([...requirements.keys(), ...reservedByProduct.keys()]);
    const rows: OrderRequirementDto[] = [];
    for (const productId of productIds) {
      const req = requirements.get(productId);
      const res = reservedByProduct.get(productId);
      const requiredQuantity = req?.required ?? res?.requiredQuantity ?? 0;
      const reservedQuantity = res?.reservedQuantity ?? 0;
      if (requiredQuantity <= 0 && reservedQuantity <= 0) continue;
      rows.push({
        productId,
        productName: req?.productName ?? productId,
        requiredQuantity,
        reservedQuantity,
        shortageQuantity: Math.max(requiredQuantity - reservedQuantity, 0),
      });
    }
    rows.sort((a, b) => a.productName.localeCompare(b.productName, 'ru'));
    return rows;
  }

  shortageSummary(requirements: OrderRequirementDto[]): {
    hasShortage: boolean;
    shortageProductCount: number;
  } {
    const shortageProductCount = requirements.filter((r) => r.shortageQuantity > 0).length;
    return { hasShortage: shortageProductCount > 0, shortageProductCount };
  }

  async lockProductStocks(tx: Tx, productIds: string[]): Promise<void> {
    const ids = [...new Set(productIds)].filter(Boolean).sort();
    for (const productId of ids) {
      await tx.$queryRaw`
        SELECT "productId" FROM product_stocks
        WHERE "productId" = ${productId}
        FOR UPDATE
      `;
    }
  }

  isActiveReservationStatus(status: OrderStatus | string): boolean {
    return ACTIVE_ORDER_STATUSES.includes(status as OrderStatus);
  }

  /**
   * Reconcile one order's reservation rows to open requirements, then globally
   * reallocate (with preemption) for touched products.
   */
  async reconcileOrderReservations(
    tx: Tx,
    orderId: string,
    options?: { skipGlobalReallocate?: boolean },
  ): Promise<{ releasedProductIds: string[]; requirements: RequirementMap }> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
    }
    if (!this.isActiveReservationStatus(order.status)) {
      throw new AppError(
        'ORDER_NOT_EDITABLE',
        'Резервы можно менять только для активных заказов',
        { status: order.status },
        HttpStatus.CONFLICT,
      );
    }

    const requirements = await this.loadOpenRequirementsForOrder(tx, orderId);
    const existing = await tx.stockReservation.findMany({ where: { orderId } });
    const allProductIds = [
      ...new Set([...requirements.keys(), ...existing.map((e) => e.productId)]),
    ];
    await this.lockProductStocks(tx, allProductIds);

    const existingByProduct = new Map(existing.map((e) => [e.productId, e]));

    for (const old of existing) {
      if (!requirements.has(old.productId)) {
        await tx.stockReservation.delete({ where: { id: old.id } });
      }
    }

    for (const [productId, req] of requirements) {
      const cur = existingByProduct.get(productId);
      const stock = await tx.productStock.findUnique({ where: { productId } });
      if (!stock) {
        throw new AppError(
          'STOCK_NOT_SUPPORTED',
          'Складская запись отсутствует',
          { productId },
          HttpStatus.CONFLICT,
        );
      }
      if (cur) {
        await tx.stockReservation.update({
          where: { id: cur.id },
          data: { requiredQuantity: req.required, reservedQuantity: 0 },
        });
      } else {
        await tx.stockReservation.create({
          data: {
            orderId,
            productId,
            requiredQuantity: req.required,
            reservedQuantity: 0,
          },
        });
      }
    }

    if (!options?.skipGlobalReallocate) {
      await this.reallocateProducts(tx, allProductIds);
    }

    return { releasedProductIds: allProductIds, requirements };
  }

  /** Release all reservations for an order (cancel). */
  async releaseAllForOrder(
    tx: Tx,
    orderId: string,
    options?: { reallocate?: boolean },
  ): Promise<string[]> {
    const rows = await tx.stockReservation.findMany({ where: { orderId } });
    if (rows.length === 0) return [];
    const productIds = [...new Set(rows.map((r) => r.productId))].sort();
    await this.lockProductStocks(tx, productIds);

    for (const row of rows) {
      await tx.stockReservation.delete({ where: { id: row.id } });
    }

    if (options?.reallocate !== false) {
      await this.reallocateProducts(tx, productIds);
    } else {
      await this.syncReservedAggregates(tx, productIds);
    }
    return productIds;
  }

  /**
   * Full recompute of reservedQuantity for products (preemption + suitability).
   * Caller must hold warehouse advisory lock when onHand may also change.
   */
  async reallocateProducts(
    tx: Tx,
    productIds: string[],
    context?: RequestContext,
    actorUserId?: string,
  ): Promise<{ allocatedTotal: number; productsTouched: string[]; preempted: boolean }> {
    const ids = [...new Set(productIds)].filter(Boolean).sort();
    if (ids.length === 0) {
      return { allocatedTotal: 0, productsTouched: [], preempted: false };
    }

    await this.lockProductStocks(tx, ids);

    let allocatedTotal = 0;
    const productsTouched: string[] = [];
    let preempted = false;

    for (const productId of ids) {
      const before = await tx.stockReservation.findMany({
        where: { productId },
        select: { orderId: true, reservedQuantity: true },
      });
      const beforeMap = new Map(before.map((b) => [b.orderId, b.reservedQuantity]));

      const stock = await tx.productStock.findUnique({ where: { productId } });
      if (!stock) continue;

      const demands = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          requiredQuantity: number;
          fulfillmentDate: Date;
          fulfillmentTimeFrom: string | null;
          createdAt: Date;
          number: string;
        }>
      >`
        SELECT
          r.id,
          r."orderId",
          r."requiredQuantity",
          o."fulfillmentDate",
          o."fulfillmentTimeFrom",
          o."createdAt",
          o.number
        FROM stock_reservations r
        INNER JOIN orders o ON o.id = r."orderId"
        WHERE r."productId" = ${productId}
          AND r."requiredQuantity" > 0
          AND o.status IN ('NEW', 'IN_PROGRESS', 'READY')
        ORDER BY
          o."fulfillmentDate" ASC,
          CASE WHEN o."fulfillmentTimeFrom" IS NULL THEN 1 ELSE 0 END ASC,
          o."fulfillmentTimeFrom" ASC NULLS LAST,
          o."createdAt" ASC,
          o.number ASC,
          r.id ASC
        FOR UPDATE OF r
      `;

      const lots = await tx.$queryRaw<
        Array<{
          id: string;
          remainingQuantity: number;
          usableUntil: Date | null;
          receivedAt: Date;
        }>
      >`
        SELECT id, "remainingQuantity", "usableUntil", "receivedAt"
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

      // Virtual lot pool for suitability simulation (does not pin lots).
      // Null usableUntil uses conservative shelf window (see lot-suitability.ts).
      const virtual = lots.map((l) => ({
        remaining: l.remainingQuantity,
        usableUntil: l.usableUntil,
        receivedAt: l.receivedAt,
      }));

      let productAllocated = 0;
      const onHandCap = stock.quantityOnHand;
      let usedOnHand = 0;

      for (const row of demands) {
        let take = 0;
        const need = row.requiredQuantity;
        for (const lot of virtual) {
          if (take >= need || usedOnHand >= onHandCap) break;
          if (lot.remaining <= 0) continue;
          if (!isLotSuitableForDate(lot, row.fulfillmentDate)) continue;
          const room = Math.min(lot.remaining, need - take, onHandCap - usedOnHand);
          if (room <= 0) continue;
          lot.remaining -= room;
          take += room;
          usedOnHand += room;
        }

        await tx.stockReservation.update({
          where: { id: row.id },
          data: { reservedQuantity: take },
        });
        productAllocated += take;

        const prev = beforeMap.get(row.orderId) ?? 0;
        if (prev > take) preempted = true;
      }

      await tx.productStock.update({
        where: { productId },
        data: { quantityReserved: productAllocated },
      });

      // Clear reserved on orphan rows not in demand list (required=0 should not exist).
      allocatedTotal += productAllocated;
      if (productAllocated > 0 || before.length > 0) productsTouched.push(productId);
    }

    if (allocatedTotal > 0 && context && actorUserId) {
      await this.audit.log({
        action: AuditAction.STOCK_RESERVATIONS_ALLOCATED,
        actorUserId,
        entityType: 'ProductStock',
        entityId: ids[0] ?? null,
        metadata: {
          allocatedTotal,
          productsTouched,
          productCount: productsTouched.length,
          preempted,
        },
        context,
        tx,
      });
    }
    if (preempted && context && actorUserId) {
      await this.audit.log({
        action: AuditAction.STOCK_RESERVATIONS_PREEMPTED,
        actorUserId,
        entityType: 'ProductStock',
        entityId: ids[0] ?? null,
        metadata: { productsTouched },
        context,
        tx,
      });
    }

    return { allocatedTotal, productsTouched, preempted };
  }

  /** Back-compat alias used by supply/inventory hooks. */
  async allocateAvailableForProducts(
    tx: Tx,
    productIds: string[],
    context?: RequestContext,
    actorUserId?: string,
  ): Promise<{ allocatedTotal: number; productsTouched: string[] }> {
    const result = await this.reallocateProducts(tx, productIds, context, actorUserId);
    return { allocatedTotal: result.allocatedTotal, productsTouched: result.productsTouched };
  }

  async syncReservedAggregates(tx: Tx, productIds: string[]): Promise<void> {
    const ids = [...new Set(productIds)].filter(Boolean).sort();
    await this.lockProductStocks(tx, ids);
    for (const productId of ids) {
      const sum = await tx.stockReservation.aggregate({
        where: { productId },
        _sum: { reservedQuantity: true },
      });
      const reserved = sum._sum.reservedQuantity ?? 0;
      const stock = await tx.productStock.findUnique({ where: { productId } });
      if (!stock) continue;
      if (reserved > stock.quantityOnHand) {
        throw new AppError(
          'RESERVATION_INVARIANT_VIOLATION',
          'Нарушение инварианта резерва склада',
          { productId, reserved, quantityOnHand: stock.quantityOnHand },
          HttpStatus.CONFLICT,
        );
      }
      await tx.productStock.update({
        where: { productId },
        data: { quantityReserved: reserved },
      });
    }
  }

  async assertNoShortage(tx: Tx, orderId: string): Promise<void> {
    const rows = await tx.stockReservation.findMany({ where: { orderId } });
    const shortage = rows.filter((r) => r.reservedQuantity < r.requiredQuantity);
    if (shortage.length > 0) {
      throw new AppError(
        'ORDER_HAS_SHORTAGE',
        'Заказ нельзя перевести: не хватает зарезервированного товара',
        {
          shortageProductCount: shortage.length,
          products: shortage.map((s) => ({
            productId: s.productId,
            requiredQuantity: s.requiredQuantity,
            reservedQuantity: s.reservedQuantity,
            shortageQuantity: s.requiredQuantity - s.reservedQuantity,
          })),
        },
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * How many stems of productId this order currently holds in planned reserve.
   * Used by assembly to detect override of higher-priority reservations.
   */
  async reservedForOrder(tx: Tx, orderId: string, productId: string): Promise<number> {
    const row = await tx.stockReservation.findUnique({
      where: { orderId_productId: { orderId, productId } },
    });
    return row?.reservedQuantity ?? 0;
  }

  /** Compare priority of two active orders (lower = higher priority). */
  comparePriority(a: ActiveOrderPriorityRow, b: ActiveOrderPriorityRow): number {
    const da = a.fulfillmentDate.getTime();
    const db = b.fulfillmentDate.getTime();
    if (da !== db) return da - db;
    const aTimed = a.fulfillmentTimeFrom != null ? 0 : 1;
    const bTimed = b.fulfillmentTimeFrom != null ? 0 : 1;
    if (aTimed !== bTimed) return aTimed - bTimed;
    if (a.fulfillmentTimeFrom && b.fulfillmentTimeFrom) {
      const cmp = a.fulfillmentTimeFrom.localeCompare(b.fulfillmentTimeFrom);
      if (cmp !== 0) return cmp;
    }
    const ca = a.createdAt.getTime() - b.createdAt.getTime();
    if (ca !== 0) return ca;
    return a.number.localeCompare(b.number);
  }

  /** Suitable remaining helper exposed for diagnostics. */
  async suitableOnHand(tx: Tx, productId: string, fulfillmentDate: Date): Promise<number> {
    return this.stockFifo.suitableRemainingQuantity(tx, productId, fulfillmentDate);
  }
}
