import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DiscountType,
  FulfillmentType,
  OrderFulfillmentMode,
  OrderItemType,
  OrderPaymentStatus,
  OrderSource,
  OrderStatus,
  Permission,
  PosPriceMode,
  ProductType,
  Role,
  AssembledBouquetStatus,
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
import { decimalToMoneyString, parseMoneyInput } from '../products/product-mapper';
import { computeOrderPaymentSummary } from '../payments/payment-calc';
import { paymentInclude, toPaymentDto } from '../payments/payment-mapper';
import { buildFulfillmentProgress } from './order-progress';
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
      assembledBouquets: {
        select: { id: true, status: true },
      },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
  reservations: true,
  assembledBouquets: {
    where: { status: AssembledBouquetStatus.ASSEMBLED },
    include: {
      assembledBy: { select: { name: true } },
      order: { select: { number: true } },
    },
    orderBy: { assembledAt: 'desc' as const },
  },
  payments: {
    include: paymentInclude,
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
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
      IN_PROGRESS: 0,
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
        if (existing.status === OrderStatus.CANCELLED) {
          throw new AppError(
            'ORDER_NOT_EDITABLE',
            'Отменённый заказ нельзя редактировать.',
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

        const compositionLocked = this.isCompositionLocked(existing);
        const wantsItemReplace = dto.items !== undefined;

        // Header-only update: never delete/recreate lines (preserves POS snapshots & AB links).
        // Allowed after confirm (e.g. POS READY) so operators can fix customer/comment fields.
        if (!wantsItemReplace) {
          return this.updateHeaderOnly(tx, actor, existing, dto, context);
        }

        // Composition lock takes precedence over the NEW-status gate (clearer POS error).
        if (compositionLocked) {
          throw new AppError(
            'ORDER_COMPOSITION_LOCKED',
            'Состав этого заказа нельзя менять через форму заказа (индивидуальные букеты, услуги, привязанные готовые букеты или заказ из продаж). Измените заказ до подтверждения корзины или через складские операции.',
            {
              source: existing.source,
              hasLinkedAssembled: existing.assembledBouquets.length > 0,
            },
            HttpStatus.CONFLICT,
          );
        }

        if (existing.status !== OrderStatus.NEW) {
          throw new AppError(
            'ORDER_NOT_EDITABLE',
            'Редактировать состав можно только в статусе «Новый».',
            { status: existing.status },
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
            mode: 'composition_replace',
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

  /** Orders whose line snapshot must not be delete-recreated. */
  private isCompositionLocked(existing: OrderRow): boolean {
    if ((existing.source as OrderSource | undefined) === OrderSource.POS) return true;
    if (existing.assembledBouquets.length > 0) return true;
    for (const item of existing.items) {
      if (item.parentOrderItemId) return true;
      if (item.itemType === OrderItemType.BOUQUET && !item.bouquetId) return true;
      if (item.priceOverridden) return true;
      if (item.lineDiscountAmount && !item.lineDiscountAmount.equals(0)) return true;
      if ((item.assembledBouquets ?? []).length > 0) return true;
    }
    return false;
  }

  private async updateHeaderOnly(
    tx: Tx,
    actor: AuthenticatedUser,
    existing: OrderRow,
    dto: UpdateOrderDto,
    context: RequestContext,
  ): Promise<OrderRow> {
    const id = existing.id;
    // Recompute money only if cart-level discount fields change; keep line snapshots intact.
    let discountType =
      dto.discountType !== undefined
        ? (dto.discountType as DiscountType | null)
        : (existing.discountType as DiscountType | null);
    let discountValue =
      dto.discountValue !== undefined
        ? dto.discountValue
          ? parseMoneyInput(dto.discountValue)
          : null
        : existing.discountValue;
    let discountAmount = existing.discountAmount;
    let total = existing.total;
    const subtotal = existing.subtotal;

    if (dto.discountType !== undefined || dto.discountValue !== undefined) {
      this.assertDiscountPermission(
        actor,
        discountType,
        discountValue ? discountValue.toFixed(2) : null,
        [],
      );
      discountAmount = new Prisma.Decimal(0);
      if (discountType && discountValue) {
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
      }
      total = subtotal.minus(discountAmount);
      if (total.lessThan(0)) total = new Prisma.Decimal(0);
    }

    const before = this.auditSnapshot(existing);
    const cas = await tx.order.updateMany({
      where: {
        id,
        version: dto.expectedVersion,
        status: { not: OrderStatus.CANCELLED },
      },
      data: {
        version: { increment: 1 },
        customerName:
          dto.customerName !== undefined ? (dto.customerName ?? '').trim() : existing.customerName,
        customerPhone:
          dto.customerPhone !== undefined
            ? (dto.customerPhone ?? '').trim()
            : existing.customerPhone,
        fulfillmentType: (dto.fulfillmentType ?? existing.fulfillmentType) as FulfillmentType,
        fulfillmentDate: dto.fulfillmentDate
          ? parseIsoDateOnly(dto.fulfillmentDate)
          : existing.fulfillmentDate,
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
          dto.deliveryLatitude !== undefined ? dto.deliveryLatitude : existing.deliveryLatitude,
        deliveryLongitude:
          dto.deliveryLongitude !== undefined ? dto.deliveryLongitude : existing.deliveryLongitude,
        deliveryProvider:
          dto.deliveryProvider !== undefined ? dto.deliveryProvider : existing.deliveryProvider,
        deliveryProviderPlaceId:
          dto.deliveryProviderPlaceId !== undefined
            ? dto.deliveryProviderPlaceId
            : existing.deliveryProviderPlaceId,
        deliveryComment:
          dto.deliveryComment !== undefined ? dto.deliveryComment : existing.deliveryComment,
        orderComment: dto.orderComment !== undefined ? dto.orderComment : existing.orderComment,
        discountType,
        discountValue,
        discountAmount,
        total,
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

    const row = await tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
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
        mode: 'header_only',
      },
      context,
      tx,
    });
    return row;
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
          await this.assertAssembleableReady(tx, id);
        }

        if (dto.status === OrderStatus.CANCELLED || dto.status === OrderStatus.COMPLETED) {
          await this.warehouseLock.beginStockMutation(tx);
        }

        if (dto.status === OrderStatus.COMPLETED) {
          await this.assertOrderReadyToComplete(tx, id);
        }

        const now = new Date();
        const data: Prisma.OrderUncheckedUpdateManyInput = {
          version: { increment: 1 },
          status: dto.status,
          updatedByUserId: actor.id,
        };
        if (dto.status === OrderStatus.IN_PROGRESS)
          data.inProgressAt = existing.inProgressAt ?? now;
        if (dto.status === OrderStatus.READY) data.readyAt = now;
        if (dto.status === OrderStatus.COMPLETED) data.completedAt = now;
        if (dto.status === OrderStatus.CANCELLED) data.cancelledAt = now;
        if (dto.status === OrderStatus.NEW) {
          data.inProgressAt = null;
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
          // Release planned reserve only. Assembled bouquets stay physical — no auto-disassemble.
          await this.reservationAllocation.releaseAllForOrder(tx, id, { reallocate: true });
        }

        if (dto.status === OrderStatus.COMPLETED) {
          await this.reservationAllocation.releaseAllForOrder(tx, id, { reallocate: true });
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

  /** All bouquet lines fully assembled (ASSEMBLED or ISSUED). */
  private async assertAssembleableReady(tx: Tx, orderId: string): Promise<void> {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      if (item.itemType !== OrderItemType.BOUQUET) continue;
      const count = await tx.assembledBouquet.count({
        where: {
          orderItemId: item.id,
          status: {
            in: [AssembledBouquetStatus.ASSEMBLED, AssembledBouquetStatus.ISSUED],
          },
        },
      });
      if (count < item.quantity) {
        throw new AppError(
          'ORDER_NOT_FULLY_ASSEMBLED',
          'Не все букеты заказа собраны',
          { orderItemId: item.id, need: item.quantity, assembled: count },
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  /**
   * COMPLETED requires physical leave-shop already done via issue / direct-issue APIs.
   * No auto SALE of planned reserve (legacy path removed).
   */
  private async assertOrderReadyToComplete(tx: Tx, orderId: string): Promise<void> {
    const left = await tx.assembledBouquet.count({
      where: { orderId, status: AssembledBouquetStatus.ASSEMBLED },
    });
    if (left > 0) {
      throw new AppError(
        'ORDER_HAS_UNISSUED_BOUQUETS',
        'Сначала выдайте собранные букеты, затем завершите заказ',
        { remainingAssembled: left },
        HttpStatus.CONFLICT,
      );
    }
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      if (item.quantityIssued < item.quantity) {
        // Bouquet lines may count ISSUED bouquets instead of quantityIssued
        if (item.itemType === OrderItemType.BOUQUET) {
          const issued = await tx.assembledBouquet.count({
            where: {
              orderItemId: item.id,
              status: {
                in: [AssembledBouquetStatus.ISSUED, AssembledBouquetStatus.WRITTEN_OFF],
              },
            },
          });
          if (issued >= item.quantity) continue;
        }
        throw new AppError(
          'ORDER_NOT_FULLY_ISSUED',
          'Не все позиции заказа выданы',
          { orderItemId: item.id, quantity: item.quantity, quantityIssued: item.quantityIssued },
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private assertTransition(from: OrderStatus, to: OrderStatus): void {
    const allowed: Record<OrderStatus, OrderStatus[]> = {
      [OrderStatus.NEW]: [OrderStatus.IN_PROGRESS, OrderStatus.READY, OrderStatus.CANCELLED],
      [OrderStatus.IN_PROGRESS]: [OrderStatus.READY, OrderStatus.NEW, OrderStatus.CANCELLED],
      [OrderStatus.READY]: [
        OrderStatus.COMPLETED,
        OrderStatus.IN_PROGRESS,
        OrderStatus.NEW,
        OrderStatus.CANCELLED,
      ],
      [OrderStatus.COMPLETED]: [],
      [OrderStatus.CANCELLED]: [],
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
    this.applyWalkInDefault(where, query);
    return where;
  }

  /**
   * Kanban hides finished POS walk-in sales (they are receipts, not work to do) unless the
   * caller explicitly asks (`includeWalkIn`, `source`), looks one up (`search`) or filters
   * by `status=COMPLETED`. NEW / IN_PROGRESS / READY POS orders always stay visible.
   */
  private applyWalkInDefault(where: Prisma.OrderWhereInput, query: OrderQueryDto): void {
    if (query.source) where.source = query.source;
    if (query.includeWalkIn || query.source || query.search?.trim()) return;
    if (query.status === OrderStatus.COMPLETED) return;
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        NOT: {
          source: OrderSource.POS,
          fulfillmentMode: OrderFulfillmentMode.WALK_IN,
          status: OrderStatus.COMPLETED,
        },
      },
    ];
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
    this.applyWalkInDefault(where, query);
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
      return row.status === OrderStatus.NEW ||
        row.status === OrderStatus.IN_PROGRESS ||
        row.status === OrderStatus.READY
        ? 'past_date'
        : 'none';
    }
    if (date > businessDate) return 'none';
    if (!row.fulfillmentTimeFrom) return 'none';
    const deadline = row.fulfillmentTimeTo ?? row.fulfillmentTimeFrom;
    if (compareHm(businessHm, deadline) > 0) {
      return row.status === OrderStatus.NEW || row.status === OrderStatus.IN_PROGRESS
        ? 'overdue'
        : 'attention';
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
      source?: OrderSource | string;
      fulfillmentMode?: OrderFulfillmentMode | string;
      paymentStatus?: OrderPaymentStatus | string;
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
      source: (row.source as OrderSource | undefined) ?? OrderSource.BACKOFFICE,
      fulfillmentMode:
        (row.fulfillmentMode as OrderFulfillmentMode | undefined) ?? OrderFulfillmentMode.SCHEDULED,
      paymentStatus:
        (row.paymentStatus as OrderPaymentStatus | undefined) ?? OrderPaymentStatus.UNPAID,
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
    // Detail requirements reflect open (unassembled) needs via reservation rows.
    const requirementsRaw = this.reservationAllocation.toRequirementDtos(
      new Map(
        row.reservations.map((r) => [
          r.productId,
          {
            productId: r.productId,
            productName:
              row.items.flatMap((i) => i.components).find((c) => c.productId === r.productId)
                ?.productNameSnapshot ??
              row.items.find((i) => i.productId === r.productId)?.nameSnapshot ??
              r.productId,
            required: r.requiredQuantity,
          },
        ]),
      ),
      row.reservations,
    );
    const requirements =
      (row.status as OrderStatus) === OrderStatus.COMPLETED
        ? []
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

    const canSeeCost = canViewPurchasePrice;
    const paymentSummary = computeOrderPaymentSummary(row.total, row.payments);
    const assembledBouquets = (row.assembledBouquets ?? []).map((b) => ({
      id: b.id,
      number: b.number,
      status: b.status as AssembledBouquetStatus,
      orderId: b.orderId,
      orderNumber: b.order?.number ?? row.number,
      orderItemId: b.orderItemId,
      bouquetTemplateId: b.bouquetTemplateId,
      nameSnapshot: b.nameSnapshot,
      version: b.version,
      unitCost: canSeeCost ? decimalToMoneyString(b.unitCost) : null,
      hasUncostedComponents: b.hasUncostedComponents,
      assembledAt: b.assembledAt.toISOString(),
      assembledByName: b.assembledBy?.name ?? '',
    }));

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
      inProgressAt: row.inProgressAt?.toISOString() ?? null,
      readyAt: row.readyAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      items: row.items.map((item) => this.toItemDto(item)),
      requirements,
      assembledBouquets,
      paymentSummary,
      payments: row.payments.map((p) => toPaymentDto(p)),
      fulfillmentProgress: buildFulfillmentProgress(row, paymentSummary),
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
      priceMode: (c.priceMode as PosPriceMode | undefined) ?? PosPriceMode.ADDITIONAL,
      unitSalePriceSnapshot: decimalToMoneyString(c.unitSalePriceSnapshot),
      sortOrder: c.sortOrder,
    }));
    const itemType = item.itemType as OrderItemType;
    const quantityAssembled = (item.assembledBouquets ?? []).filter(
      (b) => b.status === AssembledBouquetStatus.ASSEMBLED,
    ).length;
    return {
      id: item.id,
      itemType,
      productId: item.productId,
      bouquetId: item.bouquetId,
      parentOrderItemId: item.parentOrderItemId ?? null,
      priceMode: (item.priceMode as PosPriceMode | undefined) ?? PosPriceMode.ADDITIONAL,
      nameSnapshot: item.nameSnapshot,
      quantity: item.quantity,
      quantityIssued: item.quantityIssued,
      quantityAssembled,
      recommendedUnitPrice: decimalToMoneyString(item.recommendedUnitPrice),
      unitPrice: decimalToMoneyString(item.unitPrice) ?? '0.00',
      priceOverridden: item.priceOverridden ?? false,
      lineDiscountType: (item.lineDiscountType as DiscountType | null | undefined) ?? null,
      lineDiscountValue: decimalToMoneyString(item.lineDiscountValue),
      lineDiscountAmount: decimalToMoneyString(item.lineDiscountAmount) ?? '0.00',
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
