import { HttpStatus, Injectable } from '@nestjs/common';
import {
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

/**
 * Mutable StockReservation engine.
 *
 * Lock order (compatible with warehouse mutations):
 * 1. warehouse advisory xact lock (caller)
 * 2. business document (caller)
 * 3. ProductStock FOR UPDATE sorted by productId
 * 4. StockReservation rows (via ProductStock already locked)
 * 5. StockLots FIFO (completion only)
 *
 * Preemption: existing reservations are NEVER stolen by newer higher-priority orders.
 * Priority applies only when allocating NEW or RELEASED available stock.
 */
@Injectable()
export class ReservationAllocationService {
  constructor(private readonly audit: AuditService) {}

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

  /**
   * Reconcile reservations for one order to match snapshot requirements.
   * Releases excess to ProductStock.quantityReserved, then attempts to fill shortages
   * for this order from available, then reallocates any released stock globally.
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
    if (order.status !== OrderStatus.NEW && order.status !== OrderStatus.READY) {
      throw new AppError(
        'ORDER_NOT_EDITABLE',
        'Резервы можно менять только для активных заказов',
        { status: order.status },
        HttpStatus.CONFLICT,
      );
    }

    const requirements = await this.loadRequirementsForOrder(tx, orderId);
    const existing = await tx.stockReservation.findMany({ where: { orderId } });
    const allProductIds = [
      ...new Set([...requirements.keys(), ...existing.map((e) => e.productId)]),
    ];
    await this.lockProductStocks(tx, allProductIds);

    const releasedProductIds = new Set<string>();
    const existingByProduct = new Map(existing.map((e) => [e.productId, e]));

    for (const old of existing) {
      if (!requirements.has(old.productId)) {
        if (old.reservedQuantity > 0) {
          await this.adjustReserved(tx, old.productId, -old.reservedQuantity);
          releasedProductIds.add(old.productId);
        }
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

      let reserved = cur?.reservedQuantity ?? 0;
      if (reserved > req.required) {
        const release = reserved - req.required;
        await this.adjustReserved(tx, productId, -release);
        reserved = req.required;
        releasedProductIds.add(productId);
      }

      const fresh = await tx.productStock.findUniqueOrThrow({ where: { productId } });
      const availNow = fresh.quantityOnHand - fresh.quantityReserved;
      const need = req.required - reserved;
      if (need > 0 && availNow > 0) {
        const take = Math.min(need, availNow);
        await this.adjustReserved(tx, productId, take);
        reserved += take;
      }

      if (cur) {
        await tx.stockReservation.update({
          where: { id: cur.id },
          data: { requiredQuantity: req.required, reservedQuantity: reserved },
        });
      } else {
        await tx.stockReservation.create({
          data: {
            orderId,
            productId,
            requiredQuantity: req.required,
            reservedQuantity: reserved,
          },
        });
      }
    }

    if (!options?.skipGlobalReallocate && releasedProductIds.size > 0) {
      await this.allocateAvailableForProducts(tx, [...releasedProductIds]);
    }

    return { releasedProductIds: [...releasedProductIds], requirements };
  }

  /** Release all reservations for an order (cancel / pre-completion consume path uses separate consume). */
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
      if (row.reservedQuantity > 0) {
        await this.adjustReserved(tx, row.productId, -row.reservedQuantity);
      }
      await tx.stockReservation.delete({ where: { id: row.id } });
    }

    if (options?.reallocate !== false) {
      await this.allocateAvailableForProducts(tx, productIds);
    }
    return productIds;
  }

  /**
   * Allocate available stock to shortage reservations by priority.
   * Caller must hold warehouse advisory lock. ProductStocks will be locked here.
   */
  async allocateAvailableForProducts(
    tx: Tx,
    productIds: string[],
    context?: RequestContext,
    actorUserId?: string,
  ): Promise<{ allocatedTotal: number; productsTouched: string[] }> {
    const ids = [...new Set(productIds)].filter(Boolean).sort();
    if (ids.length === 0) return { allocatedTotal: 0, productsTouched: [] };

    await this.lockProductStocks(tx, ids);

    let allocatedTotal = 0;
    const productsTouched: string[] = [];

    for (const productId of ids) {
      const stock = await tx.productStock.findUnique({ where: { productId } });
      if (!stock) continue;
      let available = stock.quantityOnHand - stock.quantityReserved;
      if (available <= 0) continue;

      const shortages = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          requiredQuantity: number;
          reservedQuantity: number;
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
          r."reservedQuantity",
          o."fulfillmentDate",
          o."fulfillmentTimeFrom",
          o."createdAt",
          o.number
        FROM stock_reservations r
        INNER JOIN orders o ON o.id = r."orderId"
        WHERE r."productId" = ${productId}
          AND r."requiredQuantity" > r."reservedQuantity"
          AND o.status IN ('NEW', 'READY')
        ORDER BY
          o."fulfillmentDate" ASC,
          CASE WHEN o."fulfillmentTimeFrom" IS NULL THEN 1 ELSE 0 END ASC,
          o."fulfillmentTimeFrom" ASC NULLS LAST,
          o."createdAt" ASC,
          o.number ASC
        FOR UPDATE OF r
      `;

      let productAllocated = 0;
      for (const row of shortages) {
        if (available <= 0) break;
        const need = row.requiredQuantity - row.reservedQuantity;
        const take = Math.min(need, available);
        if (take <= 0) continue;
        await tx.stockReservation.update({
          where: { id: row.id },
          data: { reservedQuantity: row.reservedQuantity + take },
        });
        await this.adjustReserved(tx, productId, take);
        available -= take;
        productAllocated += take;
        allocatedTotal += take;
      }
      if (productAllocated > 0) productsTouched.push(productId);
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
        },
        context,
        tx,
      });
    }

    return { allocatedTotal, productsTouched };
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

  private async adjustReserved(tx: Tx, productId: string, delta: number): Promise<void> {
    if (delta === 0) return;
    const stock = await tx.productStock.findUnique({ where: { productId } });
    if (!stock) {
      throw new AppError(
        'STOCK_NOT_SUPPORTED',
        'Складская запись отсутствует',
        { productId },
        HttpStatus.CONFLICT,
      );
    }
    const next = stock.quantityReserved + delta;
    if (next < 0 || next > stock.quantityOnHand) {
      throw new AppError(
        'RESERVATION_INVARIANT_VIOLATION',
        'Нарушение инварианта резерва склада',
        {
          productId,
          quantityOnHand: stock.quantityOnHand,
          quantityReserved: stock.quantityReserved,
          delta,
          nextReserved: next,
        },
        HttpStatus.CONFLICT,
      );
    }
    await tx.productStock.update({
      where: { productId },
      data: { quantityReserved: next },
    });
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
}
