import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DiscountType,
  FulfillmentType,
  OrderItemType,
  OrderStatus,
  Permission,
  ProductType,
  Role,
  StockMovementType,
  Unit,
  roleHasPermission,
  type BusinessTimeInfo,
  type OrderDetail,
  type OrderItemComponentDto,
  type OrderItemDto,
  type OrderListItem,
  type OrderListResult,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { WarehouseLockService } from '../warehouse/warehouse-lock.service';
import { ReservationAllocationService } from '../warehouse/reservation-allocation.service';
import { StockFifoService } from '../warehouse/stock-fifo.service';
import { decimalToMoneyString, parseMoneyInput } from '../products/product-mapper';
import {
  businessDateString,
  businessTimeHm,
  compareHm,
  formatOrderNumber,
  isValidHm,
  isoDateFromDb,
  parseIsoDateOnly,
} from './business-time';
import {
  ChangeOrderStatusDto,
  CreateOrderDto,
  OrderItemInputDto,
  OrderQueryDto,
  UpdateOrderDto,
} from './dto/order.dto';

type Tx = Prisma.TransactionClient;

const orderInclude = {
  items: {
    include: {
      components: { orderBy: { sortOrder: 'asc' as const } },
      product: { select: { type: true, name: true } },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
  reservations: true,
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

/** Kanban/list DTO fields only — no createdBy/updatedBy, lean reservation/item selects. */
const orderListInclude = {
  items: {
    select: {
      quantity: true,
      nameSnapshot: true,
      sortOrder: true,
    },
    orderBy: { sortOrder: 'asc' as const },
  },
  reservations: {
    select: {
      requiredQuantity: true,
      reservedQuantity: true,
    },
  },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly warehouseLock: WarehouseLockService,
    private readonly reservationAllocation: ReservationAllocationService,
    private readonly stockFifo: StockFifoService,
  ) {}

  businessTime(now = new Date()): BusinessTimeInfo {
    const timeZone = this.config.businessTimeZone;
    return {
      timeZone,
      businessDate: businessDateString(now, timeZone),
      nowIso: now.toISOString(),
    };
  }

  async list(actor: AuthenticatedUser, query: OrderQueryDto): Promise<OrderListResult> {
    void actor;
    const page = query.page ?? 1;
    const limit = query.limit ?? 200;
    const search = query.search?.trim() ?? '';
    if (!query.date && !search) {
      throw new AppError(
        'ORDER_DATE_REQUIRED',
        'Укажите дату выполнения (date=YYYY-MM-DD) или поисковый запрос (search)',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    if (search && search.length < 2) {
      throw new AppError(
        'ORDER_SEARCH_TOO_SHORT',
        'Поисковый запрос должен содержать минимум 2 символа',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    const fulfillmentDate = query.date ? parseIsoDateOnly(query.date) : null;
    const crossDay = fulfillmentDate == null;
    const where = this.buildListWhere(query, fulfillmentDate);

    const orderBy: Prisma.OrderOrderByWithRelationInput[] = crossDay
      ? [
          { fulfillmentDate: 'desc' },
          { fulfillmentTimeFrom: { sort: 'asc', nulls: 'last' } },
          { number: 'asc' },
        ]
      : [{ fulfillmentTimeFrom: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }];

    const [total, rows, statusGroups, typeGroups] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: orderListInclude,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: this.summaryWhere(query, fulfillmentDate, { dropStatus: true }),
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['fulfillmentType'],
        where: this.summaryWhere(query, fulfillmentDate, {
          dropStatus: true,
          dropFulfillmentType: true,
        }),
        _count: { _all: true },
      }),
    ]);

    // Defensive re-sort (DB already NULLS LAST); keeps tie-break deterministic.
    const sorted = [...rows].sort((a, b) => this.compareOrdersForKanban(a, b, crossDay));
    const now = new Date();
    const businessDate = businessDateString(now, this.config.businessTimeZone);
    const businessHm = businessTimeHm(now, this.config.businessTimeZone);

    const byStatus: Record<OrderStatus, number> = {
      NEW: 0,
      READY: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    for (const g of statusGroups) {
      byStatus[g.status] = g._count._all;
    }
    let delivery = 0;
    let pickup = 0;
    for (const g of typeGroups) {
      if (g.fulfillmentType === FulfillmentType.DELIVERY) delivery = g._count._all;
      if (g.fulfillmentType === FulfillmentType.PICKUP) pickup = g._count._all;
    }

    return {
      items: sorted.map((row) => this.toListItem(row, businessDate, businessHm)),
      total,
      page,
      limit,
      summary: {
        total: delivery + pickup,
        delivery,
        pickup,
        byStatus,
      },
    };
  }

  async getById(actor: AuthenticatedUser, id: string): Promise<OrderDetail> {
    const row = await this.prisma.order.findUnique({ where: { id }, include: orderInclude });
    if (!row) {
      throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
    }
    const now = new Date();
    return this.toDetail(
      row,
      businessDateString(now, this.config.businessTimeZone),
      businessTimeHm(now, this.config.businessTimeZone),
      actor,
    );
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateOrderDto,
    context: RequestContext,
  ): Promise<OrderDetail> {
    this.assertDiscountPermission(actor, dto.discountType, dto.discountValue, dto.items);
    const created = await this.prisma.$transaction(
      async (tx) => {
        const prepared = await this.preparePayload(tx, actor, dto);
        const hasFlower = this.preparedHasFlower(prepared.items);
        if (hasFlower) {
          await this.warehouseLock.beginStockMutation(tx);
        }

        const numberDate = businessDateString(new Date(), this.config.businessTimeZone);
        const seq = await this.nextDailyNumber(tx, numberDate);
        const number = formatOrderNumber(numberDate, seq);

        let order = await tx.order.create({
          data: {
            number,
            numberBusinessDate: parseIsoDateOnly(numberDate),
            status: OrderStatus.NEW,
            customerName: prepared.customerName,
            customerPhone: prepared.customerPhone,
            fulfillmentType: prepared.fulfillmentType,
            fulfillmentDate: prepared.fulfillmentDate,
            fulfillmentTimeFrom: prepared.fulfillmentTimeFrom,
            fulfillmentTimeTo: prepared.fulfillmentTimeTo,
            recipientName: prepared.recipientName,
            recipientPhone: prepared.recipientPhone,
            deliveryAddressText: prepared.deliveryAddressText,
            deliveryLatitude: prepared.deliveryLatitude,
            deliveryLongitude: prepared.deliveryLongitude,
            deliveryProvider: prepared.deliveryProvider,
            deliveryProviderPlaceId: prepared.deliveryProviderPlaceId,
            deliveryComment: prepared.deliveryComment,
            orderComment: prepared.orderComment,
            subtotal: prepared.subtotal,
            discountType: prepared.discountType,
            discountValue: prepared.discountValue,
            discountAmount: prepared.discountAmount,
            total: prepared.total,
            version: 1,
            createdByUserId: actor.id,
            items: {
              create: prepared.items.map((item, index) => ({
                itemType: item.itemType,
                productId: item.productId,
                bouquetId: item.bouquetId,
                nameSnapshot: item.nameSnapshot,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                lineSubtotal: item.lineSubtotal,
                sortOrder: index,
                components: {
                  create: item.components.map((c, ci) => ({
                    productId: c.productId,
                    productNameSnapshot: c.productNameSnapshot,
                    productTypeSnapshot: c.productTypeSnapshot,
                    unitSnapshot: c.unitSnapshot,
                    quantityPerItem: c.quantityPerItem,
                    totalQuantity: c.totalQuantity,
                    sortOrder: ci,
                  })),
                },
              })),
            },
          },
          include: orderInclude,
        });

        if (hasFlower) {
          await this.reservationAllocation.reconcileOrderReservations(tx, order.id);
          order = await tx.order.findUniqueOrThrow({
            where: { id: order.id },
            include: orderInclude,
          });
        }

        const shortage = this.shortageFromRow(order);
        await this.audit.log({
          action: AuditAction.ORDER_CREATED,
          actorUserId: actor.id,
          entityType: 'Order',
          entityId: order.id,
          after: this.auditSnapshot(order),
          metadata: {
            number: order.number,
            status: order.status,
            hasShortage: shortage.hasShortage,
            shortageProductCount: shortage.shortageProductCount,
          },
          context,
          tx,
        });

        return order;
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    const now = new Date();
    return this.toDetail(
      created,
      businessDateString(now, this.config.businessTimeZone),
      businessTimeHm(now, this.config.businessTimeZone),
      actor,
    );
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateOrderDto,
    context: RequestContext,
  ): Promise<OrderDetail> {
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.order.findUnique({ where: { id }, include: orderInclude });
        if (!existing) {
          throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
        }
        if (existing.status !== OrderStatus.NEW) {
          throw new AppError(
            'ORDER_NOT_EDITABLE',
            'Редактировать состав можно только в статусе «Новый».',
            { status: existing.status },
            HttpStatus.CONFLICT,
          );
        }
        if (existing.version !== dto.expectedVersion) {
          throw new AppError(
            'ORDER_CONFLICT',
            'Заказ был изменён другим пользователем. Обновите страницу.',
            { expectedVersion: dto.expectedVersion, currentVersion: existing.version },
            HttpStatus.CONFLICT,
          );
        }

        const merged = this.mergeUpdate(existing, dto);
        this.assertDiscountPermission(
          actor,
          merged.discountType,
          merged.discountValueRaw,
          merged.itemsInput,
        );
        const prepared = await this.preparePayload(tx, actor, merged);
        const needsStock =
          existing.reservations.length > 0 || this.preparedHasFlower(prepared.items);
        if (needsStock) {
          await this.warehouseLock.beginStockMutation(tx);
        }

        const before = this.auditSnapshot(existing);

        const cas = await tx.order.updateMany({
          where: { id, version: dto.expectedVersion, status: OrderStatus.NEW },
          data: {
            version: { increment: 1 },
            customerName: prepared.customerName,
            customerPhone: prepared.customerPhone,
            fulfillmentType: prepared.fulfillmentType,
            fulfillmentDate: prepared.fulfillmentDate,
            fulfillmentTimeFrom: prepared.fulfillmentTimeFrom,
            fulfillmentTimeTo: prepared.fulfillmentTimeTo,
            recipientName: prepared.recipientName,
            recipientPhone: prepared.recipientPhone,
            deliveryAddressText: prepared.deliveryAddressText,
            deliveryLatitude: prepared.deliveryLatitude,
            deliveryLongitude: prepared.deliveryLongitude,
            deliveryProvider: prepared.deliveryProvider,
            deliveryProviderPlaceId: prepared.deliveryProviderPlaceId,
            deliveryComment: prepared.deliveryComment,
            orderComment: prepared.orderComment,
            subtotal: prepared.subtotal,
            discountType: prepared.discountType,
            discountValue: prepared.discountValue,
            discountAmount: prepared.discountAmount,
            total: prepared.total,
            updatedByUserId: actor.id,
          },
        });
        if (cas.count === 0) {
          const current = await tx.order.findUnique({ where: { id }, select: { version: true } });
          throw new AppError(
            'ORDER_CONFLICT',
            'Заказ был изменён другим пользователем. Обновите страницу.',
            { expectedVersion: dto.expectedVersion, currentVersion: current?.version },
            HttpStatus.CONFLICT,
          );
        }

        await tx.orderItemComponent.deleteMany({ where: { orderItem: { orderId: id } } });
        await tx.orderItem.deleteMany({ where: { orderId: id } });

        for (const [index, item] of prepared.items.entries()) {
          await tx.orderItem.create({
            data: {
              orderId: id,
              itemType: item.itemType,
              productId: item.productId,
              bouquetId: item.bouquetId,
              nameSnapshot: item.nameSnapshot,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              lineSubtotal: item.lineSubtotal,
              sortOrder: index,
              components: {
                create: item.components.map((c, ci) => ({
                  productId: c.productId,
                  productNameSnapshot: c.productNameSnapshot,
                  productTypeSnapshot: c.productTypeSnapshot,
                  unitSnapshot: c.unitSnapshot,
                  quantityPerItem: c.quantityPerItem,
                  totalQuantity: c.totalQuantity,
                  sortOrder: ci,
                })),
              },
            },
          });
        }

        await this.reservationAllocation.reconcileOrderReservations(tx, id);

        const row = await tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
        const shortage = this.shortageFromRow(row);
        await this.audit.log({
          action: AuditAction.ORDER_UPDATED,
          actorUserId: actor.id,
          entityType: 'Order',
          entityId: id,
          before,
          after: this.auditSnapshot(row),
          metadata: {
            number: row.number,
            expectedVersion: dto.expectedVersion,
            version: row.version,
            hasShortage: shortage.hasShortage,
            shortageProductCount: shortage.shortageProductCount,
          },
          context,
          tx,
        });
        return row;
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    const now = new Date();
    return this.toDetail(
      updated,
      businessDateString(now, this.config.businessTimeZone),
      businessTimeHm(now, this.config.businessTimeZone),
      actor,
    );
  }

  async changeStatus(
    actor: AuthenticatedUser,
    id: string,
    dto: ChangeOrderStatusDto,
    context: RequestContext,
  ): Promise<OrderDetail> {
    if (dto.status === OrderStatus.CANCELLED) {
      if (!roleHasPermission(actor.role as Role, Permission.ORDERS_CANCEL)) {
        throw new AppError(
          'FORBIDDEN',
          'Недостаточно прав для отмены заказа',
          {},
          HttpStatus.FORBIDDEN,
        );
      }
    } else if (!roleHasPermission(actor.role as Role, Permission.ORDERS_STATUS)) {
      throw new AppError(
        'FORBIDDEN',
        'Недостаточно прав для смены статуса',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    const needsLongTx =
      dto.status === OrderStatus.COMPLETED || dto.status === OrderStatus.CANCELLED;

    const updated = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.order.findUnique({ where: { id }, include: orderInclude });
        if (!existing) {
          throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
        }
        if (existing.version !== dto.expectedVersion) {
          throw new AppError(
            'ORDER_CONFLICT',
            'Заказ был изменён другим пользователем. Обновите страницу.',
            { expectedVersion: dto.expectedVersion, currentVersion: existing.version },
            HttpStatus.CONFLICT,
          );
        }
        this.assertTransition(existing.status as OrderStatus, dto.status);

        if (dto.status === OrderStatus.READY) {
          await this.reservationAllocation.assertNoShortage(tx, id);
        }

        if (dto.status === OrderStatus.CANCELLED || dto.status === OrderStatus.COMPLETED) {
          await this.warehouseLock.beginStockMutation(tx);
        }

        if (dto.status === OrderStatus.COMPLETED) {
          await this.reservationAllocation.assertNoShortage(tx, id);
        }

        const now = new Date();
        const data: Prisma.OrderUncheckedUpdateManyInput = {
          version: { increment: 1 },
          status: dto.status,
          updatedByUserId: actor.id,
        };
        if (dto.status === OrderStatus.READY) data.readyAt = now;
        if (dto.status === OrderStatus.COMPLETED) data.completedAt = now;
        if (dto.status === OrderStatus.CANCELLED) data.cancelledAt = now;
        if (dto.status === OrderStatus.NEW) {
          data.readyAt = null;
          data.completedAt = null;
          data.cancelledAt = null;
        }

        const cas = await tx.order.updateMany({
          where: { id, version: dto.expectedVersion, status: existing.status },
          data,
        });
        if (cas.count === 0) {
          const current = await tx.order.findUnique({
            where: { id },
            select: { version: true, status: true },
          });
          throw new AppError(
            'ORDER_CONFLICT',
            'Заказ был изменён другим пользователем. Обновите страницу.',
            { expectedVersion: dto.expectedVersion, currentVersion: current?.version },
            HttpStatus.CONFLICT,
          );
        }

        if (dto.status === OrderStatus.CANCELLED) {
          await this.reservationAllocation.releaseAllForOrder(tx, id, { reallocate: true });
        }

        if (dto.status === OrderStatus.COMPLETED) {
          await this.consumeReservationsOnComplete(tx, existing, actor.id);
        }

        const row = await tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
        const action =
          dto.status === OrderStatus.CANCELLED
            ? AuditAction.ORDER_CANCELLED
            : AuditAction.ORDER_STATUS_CHANGED;
        const shortage = this.shortageFromRow(row);
        await this.audit.log({
          action,
          actorUserId: actor.id,
          entityType: 'Order',
          entityId: id,
          before: { status: existing.status, version: existing.version },
          after: {
            status: row.status,
            version: row.version,
            actualCost: row.actualCost?.toFixed(2) ?? null,
            hasUncostedConsumption: row.hasUncostedConsumption,
          },
          metadata: {
            number: row.number,
            from: existing.status,
            to: row.status,
            hasShortage: shortage.hasShortage,
            shortageProductCount: shortage.shortageProductCount,
          },
          context,
          tx,
        });
        return row;
      },
      needsLongTx ? { maxWait: 20_000, timeout: 60_000 } : { maxWait: 20_000, timeout: 30_000 },
    );

    const now = new Date();
    return this.toDetail(
      updated,
      businessDateString(now, this.config.businessTimeZone),
      businessTimeHm(now, this.config.businessTimeZone),
      actor,
    );
  }

  /** FIFO-consume reserved stock on COMPLETED; sets actualCost / hasUncostedConsumption. */
  private async consumeReservationsOnComplete(
    tx: Tx,
    order: Pick<OrderRow, 'id' | 'number'>,
    actorUserId: string,
  ): Promise<void> {
    const reservations = await tx.stockReservation.findMany({
      where: { orderId: order.id },
      orderBy: { productId: 'asc' },
    });
    if (reservations.length === 0) {
      await tx.order.update({
        where: { id: order.id },
        data: { actualCost: new Prisma.Decimal(0), hasUncostedConsumption: false },
      });
      return;
    }

    const productIds = reservations.map((r) => r.productId);
    await this.reservationAllocation.lockProductStocks(tx, productIds);

    let knownCost = new Prisma.Decimal(0);
    let hasUncosted = false;

    let consumedProductCount = 0;
    for (const reservation of reservations) {
      const qty = reservation.reservedQuantity;
      if (qty > 0) {
        const fifo = await this.stockFifo.consumeLots(tx, reservation.productId, qty, {
          requireFullCoverage: true,
        });
        if (fifo.hasUncosted) {
          hasUncosted = true;
        } else {
          knownCost = knownCost.plus(fifo.knownCost);
        }

        const stock = await tx.productStock.findUniqueOrThrow({
          where: { productId: reservation.productId },
        });
        const nextOnHand = stock.quantityOnHand - qty;
        const nextReserved = stock.quantityReserved - qty;
        if (nextOnHand < 0 || nextReserved < 0 || nextReserved > nextOnHand) {
          throw new AppError(
            'RESERVATION_INVARIANT_VIOLATION',
            'Нарушение инварианта резерва при завершении заказа',
            {
              productId: reservation.productId,
              quantityOnHand: stock.quantityOnHand,
              quantityReserved: stock.quantityReserved,
              consume: qty,
            },
            HttpStatus.CONFLICT,
          );
        }

        await tx.productStock.update({
          where: { productId: reservation.productId },
          data: { quantityOnHand: nextOnHand, quantityReserved: nextReserved },
        });

        await tx.stockMovement.create({
          data: {
            productId: reservation.productId,
            type: StockMovementType.SALE,
            quantity: -qty,
            balanceAfter: nextOnHand,
            sourceType: 'Order',
            sourceId: order.id,
            comment: `Заказ ${order.number}`,
            createdByUserId: actorUserId,
            allocations: {
              create: fifo.allocations.map((a) => ({
                stockLotId: a.stockLotId,
                quantity: a.quantity,
                unitPurchasePrice: a.unitPurchasePrice,
              })),
            },
          },
        });

        consumedProductCount += 1;
        // Test-only: force mid-completion failure after first product for rollback coverage.
        if (process.env.ORDER_COMPLETION_FAIL_AFTER_FIRST === '1' && consumedProductCount === 1) {
          throw new AppError(
            'ORDER_COMPLETION_TEST_FAILURE',
            'Test-forced completion failure after first product',
            { orderId: order.id, productId: reservation.productId },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      }

      await tx.stockReservation.delete({ where: { id: reservation.id } });
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        actualCost: hasUncosted ? null : knownCost.toDecimalPlaces(2),
        hasUncostedConsumption: hasUncosted,
      },
    });
  }

  private assertTransition(from: OrderStatus, to: OrderStatus): void {
    const allowed: Record<OrderStatus, OrderStatus[]> = {
      NEW: [OrderStatus.READY, OrderStatus.CANCELLED],
      READY: [OrderStatus.COMPLETED, OrderStatus.NEW, OrderStatus.CANCELLED],
      COMPLETED: [],
      CANCELLED: [],
    };
    if (!allowed[from].includes(to)) {
      throw new AppError(
        'ORDER_INVALID_STATUS_TRANSITION',
        `Переход ${from} → ${to} не разрешён`,
        { from, to },
        HttpStatus.CONFLICT,
      );
    }
  }

  private async nextDailyNumber(tx: Tx, isoDate: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO order_daily_counters ("businessDate", "lastNumber", "updatedAt")
      VALUES (${parseIsoDateOnly(isoDate)}, 1, NOW())
      ON CONFLICT ("businessDate")
      DO UPDATE SET
        "lastNumber" = order_daily_counters."lastNumber" + 1,
        "updatedAt" = NOW()
      RETURNING "lastNumber"
    `;
    const value = rows[0]?.lastNumber;
    if (!value) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Не удалось выделить номер заказа',
        {},
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return value;
  }

  private assertDiscountPermission(
    actor: AuthenticatedUser,
    discountType: DiscountType | null | undefined,
    discountValue: string | null | undefined,
    items: OrderItemInputDto[],
  ): void {
    const hasOverride = items.some((i) => i.unitPrice != null && i.unitPrice !== '');
    const hasDiscount = Boolean(discountType && discountValue != null && discountValue !== '');
    if (
      (hasOverride || hasDiscount) &&
      !roleHasPermission(actor.role as Role, Permission.ORDERS_DISCOUNT)
    ) {
      throw new AppError(
        'FORBIDDEN',
        'Недостаточно прав для скидки или изменения цены',
        {},
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private mergeUpdate(
    existing: OrderRow,
    dto: UpdateOrderDto,
  ): CreateOrderDto & {
    discountValueRaw: string | null;
    itemsInput: OrderItemInputDto[];
  } {
    const itemsInput: OrderItemInputDto[] =
      dto.items ??
      existing.items.map((i) => ({
        itemType: i.itemType as OrderItemType,
        productId: i.productId,
        bouquetId: i.bouquetId,
        quantity: i.quantity,
        unitPrice: i.unitPrice.toFixed(2),
      }));
    return {
      customerName: dto.customerName ?? existing.customerName,
      customerPhone: dto.customerPhone ?? existing.customerPhone,
      fulfillmentType: (dto.fulfillmentType ?? existing.fulfillmentType) as FulfillmentType,
      fulfillmentDate: dto.fulfillmentDate ?? isoDateFromDb(existing.fulfillmentDate),
      fulfillmentTimeFrom:
        dto.fulfillmentTimeFrom !== undefined
          ? dto.fulfillmentTimeFrom
          : existing.fulfillmentTimeFrom,
      fulfillmentTimeTo:
        dto.fulfillmentTimeTo !== undefined ? dto.fulfillmentTimeTo : existing.fulfillmentTimeTo,
      recipientName: dto.recipientName !== undefined ? dto.recipientName : existing.recipientName,
      recipientPhone:
        dto.recipientPhone !== undefined ? dto.recipientPhone : existing.recipientPhone,
      deliveryAddressText:
        dto.deliveryAddressText !== undefined
          ? dto.deliveryAddressText
          : existing.deliveryAddressText,
      deliveryLatitude:
        dto.deliveryLatitude !== undefined
          ? dto.deliveryLatitude
          : existing.deliveryLatitude
            ? Number(existing.deliveryLatitude)
            : null,
      deliveryLongitude:
        dto.deliveryLongitude !== undefined
          ? dto.deliveryLongitude
          : existing.deliveryLongitude
            ? Number(existing.deliveryLongitude)
            : null,
      deliveryProvider:
        dto.deliveryProvider !== undefined ? dto.deliveryProvider : existing.deliveryProvider,
      deliveryProviderPlaceId:
        dto.deliveryProviderPlaceId !== undefined
          ? dto.deliveryProviderPlaceId
          : existing.deliveryProviderPlaceId,
      deliveryComment:
        dto.deliveryComment !== undefined ? dto.deliveryComment : existing.deliveryComment,
      orderComment: dto.orderComment !== undefined ? dto.orderComment : existing.orderComment,
      discountType: (dto.discountType !== undefined
        ? dto.discountType
        : existing.discountType) as DiscountType | null,
      discountValue:
        dto.discountValue !== undefined
          ? dto.discountValue
          : existing.discountValue
            ? existing.discountValue.toFixed(2)
            : null,
      items: itemsInput,
      discountValueRaw:
        dto.discountValue !== undefined
          ? dto.discountValue
          : existing.discountValue
            ? existing.discountValue.toFixed(2)
            : null,
      itemsInput,
    };
  }

  private async preparePayload(tx: Tx, actor: AuthenticatedUser, dto: CreateOrderDto) {
    void actor;
    if (!dto.items?.length) {
      throw new AppError(
        'ORDER_EMPTY',
        'Заказ должен содержать хотя бы одну позицию',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    const fulfillmentType = dto.fulfillmentType;
    const timeFrom = dto.fulfillmentTimeFrom?.trim() || null;
    const timeTo = dto.fulfillmentTimeTo?.trim() || null;
    if (timeFrom && !isValidHm(timeFrom)) {
      throw new AppError(
        'ORDER_INVALID_TIME',
        'Некорректное время начала',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    if (timeTo && !isValidHm(timeTo)) {
      throw new AppError(
        'ORDER_INVALID_TIME',
        'Некорректное время окончания',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    if (timeTo && !timeFrom) {
      throw new AppError(
        'ORDER_INVALID_TIME',
        'Если указано время «до», нужно указать время «с»',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    if (timeFrom && timeTo && compareHm(timeTo, timeFrom) < 0) {
      throw new AppError(
        'ORDER_INVALID_TIME',
        'Время «до» не может быть раньше времени «с»',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    let deliveryAddressText = dto.deliveryAddressText?.trim() || null;
    let recipientName = dto.recipientName?.trim() || null;
    let recipientPhone = dto.recipientPhone?.trim() || null;
    let deliveryLatitude =
      dto.deliveryLatitude === undefined || dto.deliveryLatitude === null
        ? null
        : new Prisma.Decimal(dto.deliveryLatitude);
    let deliveryLongitude =
      dto.deliveryLongitude === undefined || dto.deliveryLongitude === null
        ? null
        : new Prisma.Decimal(dto.deliveryLongitude);
    let deliveryProvider = dto.deliveryProvider?.trim() || null;
    let deliveryProviderPlaceId = dto.deliveryProviderPlaceId?.trim() || null;
    let deliveryComment = dto.deliveryComment?.trim() || null;

    if (fulfillmentType === FulfillmentType.PICKUP) {
      deliveryAddressText = null;
      deliveryLatitude = null;
      deliveryLongitude = null;
      deliveryProvider = null;
      deliveryProviderPlaceId = null;
      deliveryComment = null;
      recipientName = null;
      recipientPhone = null;
    } else {
      if (!deliveryAddressText) {
        throw new AppError(
          'ORDER_INVALID_FULFILLMENT',
          'Для доставки укажите адрес',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const preparedItems: Array<{
      itemType: OrderItemType;
      productId: string | null;
      bouquetId: string | null;
      nameSnapshot: string;
      quantity: number;
      unitPrice: Prisma.Decimal;
      lineSubtotal: Prisma.Decimal;
      /** Set for PRODUCT lines so flower detection works before DB reload. */
      productType: ProductType | null;
      components: Array<{
        productId: string;
        productNameSnapshot: string;
        productTypeSnapshot: ProductType;
        unitSnapshot: Unit;
        quantityPerItem: number;
        totalQuantity: number;
      }>;
    }> = [];

    let subtotal = new Prisma.Decimal(0);

    for (const input of dto.items) {
      if (input.itemType === OrderItemType.PRODUCT) {
        if (!input.productId || input.bouquetId) {
          throw new AppError(
            'ORDER_INVALID_ITEM',
            'Некорректная товарная позиция',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        const product = await tx.product.findUnique({ where: { id: input.productId } });
        if (!product) {
          throw new AppError('ORDER_INVALID_ITEM', 'Товар не найден', {}, HttpStatus.BAD_REQUEST);
        }
        if (!product.isActive) {
          throw new AppError(
            'ORDER_INACTIVE_PRODUCT',
            `Товар «${product.name}» неактивен`,
            { productId: product.id },
            HttpStatus.CONFLICT,
          );
        }
        if (product.salePrice == null) {
          throw new AppError(
            'ORDER_INVALID_ITEM',
            `У товара «${product.name}» не задана цена продажи`,
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        let unitPrice = product.salePrice;
        if (input.unitPrice != null && input.unitPrice !== '') {
          unitPrice = parseMoneyInput(input.unitPrice) ?? unitPrice;
        }
        const lineSubtotal = unitPrice.mul(input.quantity);
        subtotal = subtotal.plus(lineSubtotal);
        preparedItems.push({
          itemType: OrderItemType.PRODUCT,
          productId: product.id,
          bouquetId: null,
          nameSnapshot: product.name,
          quantity: input.quantity,
          unitPrice,
          lineSubtotal,
          productType: product.type as ProductType,
          components: [],
        });
      } else if (input.itemType === OrderItemType.BOUQUET) {
        if (!input.bouquetId || input.productId) {
          throw new AppError(
            'ORDER_INVALID_ITEM',
            'Некорректная позиция букета',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        const bouquet = await tx.bouquet.findUnique({
          where: { id: input.bouquetId },
          include: {
            items: {
              include: {
                product: true,
              },
              orderBy: [{ product: { type: 'asc' } }, { product: { name: 'asc' } }],
            },
          },
        });
        if (!bouquet) {
          throw new AppError('ORDER_INVALID_ITEM', 'Букет не найден', {}, HttpStatus.BAD_REQUEST);
        }
        if (!bouquet.isActive) {
          throw new AppError(
            'ORDER_INACTIVE_BOUQUET',
            `Букет «${bouquet.name}» неактивен`,
            { bouquetId: bouquet.id },
            HttpStatus.CONFLICT,
          );
        }
        let unitPrice = bouquet.salePrice;
        if (input.unitPrice != null && input.unitPrice !== '') {
          unitPrice = parseMoneyInput(input.unitPrice) ?? unitPrice;
        }
        const lineSubtotal = unitPrice.mul(input.quantity);
        subtotal = subtotal.plus(lineSubtotal);
        preparedItems.push({
          itemType: OrderItemType.BOUQUET,
          productId: null,
          bouquetId: bouquet.id,
          nameSnapshot: bouquet.name,
          quantity: input.quantity,
          unitPrice,
          lineSubtotal,
          productType: null,
          components: bouquet.items.map((bi) => ({
            productId: bi.productId,
            productNameSnapshot: bi.product.name,
            productTypeSnapshot: bi.product.type as ProductType,
            unitSnapshot: bi.product.unit as Unit,
            quantityPerItem: bi.quantity,
            totalQuantity: bi.quantity * input.quantity,
          })),
        });
      } else {
        throw new AppError(
          'ORDER_INVALID_ITEM',
          'Неизвестный тип позиции',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    let discountType = dto.discountType ?? null;
    let discountValue: Prisma.Decimal | null = null;
    let discountAmount = new Prisma.Decimal(0);
    if (discountType) {
      if (dto.discountValue == null || dto.discountValue === '') {
        throw new AppError(
          'ORDER_INVALID_DISCOUNT',
          'Укажите величину скидки',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }
      discountValue = parseMoneyInput(dto.discountValue);
      if (!discountValue) {
        throw new AppError(
          'ORDER_INVALID_DISCOUNT',
          'Некорректная скидка',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }
      if (discountType === DiscountType.PERCENT) {
        if (discountValue.lessThan(0) || discountValue.greaterThan(100)) {
          throw new AppError(
            'ORDER_INVALID_DISCOUNT',
            'Процент скидки должен быть от 0 до 100',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        discountAmount = subtotal.mul(discountValue).div(100).toDecimalPlaces(2);
      } else {
        if (discountValue.greaterThan(subtotal)) {
          throw new AppError(
            'ORDER_INVALID_DISCOUNT',
            'Скидка не может превышать сумму заказа',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        discountAmount = discountValue;
      }
    } else {
      discountType = null;
      discountValue = null;
      discountAmount = new Prisma.Decimal(0);
    }

    const total = subtotal.minus(discountAmount);
    if (total.isNegative()) {
      throw new AppError(
        'ORDER_INVALID_DISCOUNT',
        'Итоговая сумма не может быть отрицательной',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      customerName: (dto.customerName ?? '').trim(),
      customerPhone: dto.customerPhone.trim(),
      fulfillmentType,
      fulfillmentDate: parseIsoDateOnly(dto.fulfillmentDate),
      fulfillmentTimeFrom: timeFrom,
      fulfillmentTimeTo: timeTo,
      recipientName,
      recipientPhone,
      deliveryAddressText,
      deliveryLatitude,
      deliveryLongitude,
      deliveryProvider,
      deliveryProviderPlaceId,
      deliveryComment,
      orderComment: dto.orderComment?.trim() || null,
      subtotal,
      discountType,
      discountValue,
      discountAmount,
      total,
      items: preparedItems,
    };
  }

  private buildListWhere(
    query: OrderQueryDto,
    fulfillmentDate: Date | null,
  ): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {};
    if (fulfillmentDate) {
      where.fulfillmentDate = fulfillmentDate;
    }
    if (query.status) {
      where.status = query.status;
    } else if (!query.includeCancelled) {
      where.status = { not: OrderStatus.CANCELLED };
    }
    if (query.fulfillmentType) {
      where.fulfillmentType = query.fulfillmentType;
    }
    if (query.withoutTime) {
      where.fulfillmentTimeFrom = null;
    } else {
      if (query.timeFrom) {
        if (!isValidHm(query.timeFrom)) {
          throw new AppError(
            'ORDER_INVALID_TIME',
            'Некорректный timeFrom',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        where.fulfillmentTimeFrom = { gte: query.timeFrom };
      }
      if (query.timeTo) {
        if (!isValidHm(query.timeTo)) {
          throw new AppError(
            'ORDER_INVALID_TIME',
            'Некорректный timeTo',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          { fulfillmentTimeFrom: { not: null } },
          { fulfillmentTimeFrom: { lt: query.timeTo } },
        ];
      }
    }
    const searchOr = this.buildSearchOr(query.search);
    if (searchOr) {
      where.OR = searchOr;
    }
    return where;
  }

  private buildSearchOr(search: string | undefined): Prisma.OrderWhereInput[] | null {
    const q = search?.trim();
    if (!q) return null;
    const or: Prisma.OrderWhereInput[] = [
      { number: { contains: q, mode: 'insensitive' } },
      { customerName: { contains: q, mode: 'insensitive' } },
      { customerPhone: { contains: q, mode: 'insensitive' } },
      { recipientName: { contains: q, mode: 'insensitive' } },
      { recipientPhone: { contains: q, mode: 'insensitive' } },
      { deliveryAddressText: { contains: q, mode: 'insensitive' } },
      { orderComment: { contains: q, mode: 'insensitive' } },
    ];
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4 && digits !== q) {
      or.push({ customerPhone: { contains: digits } }, { recipientPhone: { contains: digits } });
    }
    return or;
  }

  private summaryWhere(
    query: OrderQueryDto,
    fulfillmentDate: Date | null,
    opts: { dropStatus?: boolean; dropFulfillmentType?: boolean },
  ): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {};
    if (fulfillmentDate) {
      where.fulfillmentDate = fulfillmentDate;
    }
    if (!opts.dropStatus) {
      if (query.status) {
        where.status = query.status;
      } else if (!query.includeCancelled) {
        where.status = { not: OrderStatus.CANCELLED };
      }
    } else if (!query.includeCancelled && !query.status) {
      where.status = { not: OrderStatus.CANCELLED };
    } else if (query.status) {
      // Column counts for Kanban: ignore selected status filter so all columns stay visible.
    }
    if (!opts.dropFulfillmentType && query.fulfillmentType) {
      where.fulfillmentType = query.fulfillmentType;
    }
    if (query.withoutTime) {
      where.fulfillmentTimeFrom = null;
    } else {
      if (query.timeFrom) {
        where.fulfillmentTimeFrom = { gte: query.timeFrom };
      }
      if (query.timeTo) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          { fulfillmentTimeFrom: { not: null } },
          { fulfillmentTimeFrom: { lt: query.timeTo } },
        ];
      }
    }
    const searchOr = this.buildSearchOr(query.search);
    if (searchOr) {
      where.OR = searchOr;
    }
    return where;
  }

  private compareOrdersForKanban(
    a: { fulfillmentDate?: Date; fulfillmentTimeFrom: string | null; number: string },
    b: { fulfillmentDate?: Date; fulfillmentTimeFrom: string | null; number: string },
    crossDay = false,
  ): number {
    if (crossDay && a.fulfillmentDate && b.fulfillmentDate) {
      const byDate = b.fulfillmentDate.getTime() - a.fulfillmentDate.getTime();
      if (byDate !== 0) return byDate;
    }
    const aHas = a.fulfillmentTimeFrom != null;
    const bHas = b.fulfillmentTimeFrom != null;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    if (aHas && bHas) {
      const cmp = compareHm(a.fulfillmentTimeFrom!, b.fulfillmentTimeFrom!);
      if (cmp !== 0) return cmp;
    }
    return a.number.localeCompare(b.number);
  }

  private attentionFor(
    row: {
      status: OrderStatus;
      fulfillmentDate: Date;
      fulfillmentTimeFrom: string | null;
      fulfillmentTimeTo: string | null;
    },
    businessDate: string,
    businessHm: string,
  ): OrderListItem['attention'] {
    if (row.status === OrderStatus.COMPLETED || row.status === OrderStatus.CANCELLED) {
      return 'none';
    }
    const date = isoDateFromDb(row.fulfillmentDate);
    if (date < businessDate) {
      return row.status === OrderStatus.NEW || row.status === OrderStatus.READY
        ? 'past_date'
        : 'none';
    }
    if (date > businessDate) return 'none';
    if (!row.fulfillmentTimeFrom) return 'none';
    const deadline = row.fulfillmentTimeTo ?? row.fulfillmentTimeFrom;
    if (compareHm(businessHm, deadline) > 0) {
      return row.status === OrderStatus.NEW ? 'overdue' : 'attention';
    }
    return 'none';
  }

  private preparedHasFlower(
    items: Array<{
      itemType: OrderItemType;
      productType: ProductType | null;
      components: Array<{ productTypeSnapshot: ProductType }>;
    }>,
  ): boolean {
    for (const item of items) {
      if (item.itemType === OrderItemType.PRODUCT && item.productType === ProductType.FLOWER) {
        return true;
      }
      if (
        item.itemType === OrderItemType.BOUQUET &&
        item.components.some((c) => c.productTypeSnapshot === ProductType.FLOWER)
      ) {
        return true;
      }
    }
    return false;
  }

  private shortageFromRow(row: {
    reservations: Array<{ requiredQuantity: number; reservedQuantity: number }>;
  }): { hasShortage: boolean; shortageProductCount: number } {
    const shortageProductCount = row.reservations.filter(
      (r) => r.reservedQuantity < r.requiredQuantity,
    ).length;
    return { hasShortage: shortageProductCount > 0, shortageProductCount };
  }

  private toListItem(
    row: {
      id: string;
      number: string;
      status: OrderStatus | string;
      fulfillmentType: FulfillmentType | string;
      fulfillmentDate: Date;
      fulfillmentTimeFrom: string | null;
      fulfillmentTimeTo: string | null;
      customerName: string;
      customerPhone: string;
      recipientName: string | null;
      recipientPhone: string | null;
      deliveryAddressText: string | null;
      total: Prisma.Decimal;
      version: number;
      createdAt: Date;
      items: Array<{ quantity: number; nameSnapshot: string }>;
      reservations: Array<{ requiredQuantity: number; reservedQuantity: number }>;
    },
    businessDate: string,
    businessHm: string,
  ): OrderListItem {
    const effectiveRecipientName = row.recipientName?.trim() || row.customerName;
    const effectiveRecipientPhone = row.recipientPhone?.trim() || row.customerPhone;
    const status = row.status as OrderStatus;
    const shortage = this.shortageFromRow(row);
    return {
      id: row.id,
      number: row.number,
      status,
      fulfillmentType: row.fulfillmentType as FulfillmentType,
      fulfillmentDate: isoDateFromDb(row.fulfillmentDate),
      fulfillmentTimeFrom: row.fulfillmentTimeFrom,
      fulfillmentTimeTo: row.fulfillmentTimeTo,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      effectiveRecipientName,
      effectiveRecipientPhone,
      deliveryAddressText: row.deliveryAddressText,
      itemCount: row.items.length,
      compositionSummary: this.compositionSummary(row.items),
      total: decimalToMoneyString(row.total) ?? '0.00',
      version: row.version,
      attention: this.attentionFor(
        {
          status,
          fulfillmentDate: row.fulfillmentDate,
          fulfillmentTimeFrom: row.fulfillmentTimeFrom,
          fulfillmentTimeTo: row.fulfillmentTimeTo,
        },
        businessDate,
        businessHm,
      ),
      hasShortage: shortage.hasShortage,
      shortageProductCount: shortage.shortageProductCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toDetail(
    row: OrderRow,
    businessDate: string,
    businessHm: string,
    actor: AuthenticatedUser,
  ): OrderDetail {
    const list = this.toListItem(row, businessDate, businessHm);
    const canViewPurchasePrice = roleHasPermission(
      actor.role as Role,
      Permission.PURCHASE_PRICE_VIEW,
    );
    const requirementsRaw = this.reservationAllocation.toRequirementDtos(
      this.reservationAllocation.buildRequirementsFromItems(row.items),
      row.reservations,
    );
    const requirements =
      (row.status as OrderStatus) === OrderStatus.COMPLETED
        ? requirementsRaw.map((r) => ({
            ...r,
            reservedQuantity: r.requiredQuantity,
            shortageQuantity: 0,
          }))
        : (row.status as OrderStatus) === OrderStatus.CANCELLED
          ? []
          : requirementsRaw;

    let actualCost: string | null = null;
    let hasUncostedConsumption = false;
    let grossProfit: string | null = null;
    if (canViewPurchasePrice) {
      hasUncostedConsumption = row.hasUncostedConsumption;
      actualCost = decimalToMoneyString(row.actualCost);
      if (actualCost != null && !row.hasUncostedConsumption) {
        grossProfit = decimalToMoneyString(row.total.minus(row.actualCost!));
      }
    }

    return {
      ...list,
      orderComment: row.orderComment,
      deliveryComment: row.deliveryComment,
      recipientName: row.recipientName,
      recipientPhone: row.recipientPhone,
      deliveryLatitude: row.deliveryLatitude ? Number(row.deliveryLatitude) : null,
      deliveryLongitude: row.deliveryLongitude ? Number(row.deliveryLongitude) : null,
      deliveryProvider: row.deliveryProvider,
      deliveryProviderPlaceId: row.deliveryProviderPlaceId,
      subtotal: decimalToMoneyString(row.subtotal) ?? '0.00',
      discountType: row.discountType as DiscountType | null,
      discountValue: decimalToMoneyString(row.discountValue),
      discountAmount: decimalToMoneyString(row.discountAmount) ?? '0.00',
      actualCost,
      hasUncostedConsumption,
      grossProfit,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdBy.name,
      updatedByUserId: row.updatedByUserId,
      updatedByName: row.updatedBy?.name ?? null,
      readyAt: row.readyAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      items: row.items.map((item) => this.toItemDto(item)),
      requirements,
    };
  }

  private toItemDto(item: OrderRow['items'][number]): OrderItemDto {
    const components: OrderItemComponentDto[] = item.components.map((c) => ({
      id: c.id,
      productId: c.productId,
      productNameSnapshot: c.productNameSnapshot,
      productTypeSnapshot: c.productTypeSnapshot as ProductType,
      unitSnapshot: c.unitSnapshot as Unit,
      quantityPerItem: c.quantityPerItem,
      totalQuantity: c.totalQuantity,
      sortOrder: c.sortOrder,
    }));
    const itemType = item.itemType as OrderItemType;
    return {
      id: item.id,
      itemType,
      productId: item.productId,
      bouquetId: item.bouquetId,
      nameSnapshot: item.nameSnapshot,
      quantity: item.quantity,
      unitPrice: decimalToMoneyString(item.unitPrice) ?? '0.00',
      lineSubtotal: decimalToMoneyString(item.lineSubtotal) ?? '0.00',
      sortOrder: item.sortOrder,
      compositionPreview:
        itemType === OrderItemType.BOUQUET
          ? components.map((c) => `${c.quantityPerItem} × ${c.productNameSnapshot}`).join(', ')
          : null,
      components,
    };
  }

  private compositionSummary(items: Array<{ quantity: number; nameSnapshot: string }>): string {
    return items
      .slice(0, 3)
      .map((i) => `${i.quantity} × ${i.nameSnapshot}`)
      .join(', ');
  }

  private auditSnapshot(order: OrderRow) {
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      fulfillmentType: order.fulfillmentType,
      fulfillmentDate: isoDateFromDb(order.fulfillmentDate),
      total: order.total.toFixed(2),
      discountAmount: order.discountAmount.toFixed(2),
      version: order.version,
      itemCount: order.items.length,
      items: order.items.map((i) => ({
        itemType: i.itemType,
        nameSnapshot: i.nameSnapshot,
        quantity: i.quantity,
        unitPrice: i.unitPrice.toFixed(2),
        componentCount: i.components.length,
      })),
    };
  }
}
