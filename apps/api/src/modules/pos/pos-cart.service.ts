import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssembledBouquetStatus,
  AuditAction,
  DiscountType,
  FulfillmentType,
  OrderFulfillmentMode,
  OrderItemType,
  OrderPaymentStatus,
  OrderSource,
  OrderStatus,
  Permission,
  PosCartLineType,
  PosCartStatus,
  PosPriceMode,
  ProductType,
  Role,
  Unit,
  roleHasPermission,
  type PosCartDto,
  type PosCartLineComponentDto,
  type PosCartLineDto,
  type PosCartListItem,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { WarehouseLockService } from '../warehouse/warehouse-lock.service';
import { ReservationAllocationService } from '../warehouse/reservation-allocation.service';
import { AssembledBouquetService } from '../warehouse/assembled-bouquet.service';
import { decimalToMoneyString, parseMoneyInput } from '../products/product-mapper';
import {
  businessDateString,
  compareHm,
  formatOrderNumber,
  isValidHm,
  parseIsoDateOnly,
} from '../orders/business-time';
import {
  computeCartTotals,
  computeComponentRecommended,
  computeLineSubtotal,
  type PosLineAmounts,
} from './pos-calc';
import {
  AddPosCartLineDto,
  ConfirmPosCartDto,
  ParkPosCartDto,
  PosCartComponentInputDto,
  UpdatePosCartDiscountDto,
  UpdatePosCartLineDto,
} from './dto/pos.dto';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const MUTATION_TX = { maxWait: 10_000, timeout: 30_000 } as const;
const CONFIRM_TX = { maxWait: 20_000, timeout: 60_000 } as const;

const cartInclude = {
  lines: {
    include: { components: { orderBy: { sortOrder: 'asc' as const } } },
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
  },
} satisfies Prisma.PosCartInclude;

type CartRow = Prisma.PosCartGetPayload<{ include: typeof cartInclude }>;
type LineRow = CartRow['lines'][number];

interface LockedCart {
  id: string;
  status: PosCartStatus;
  ownerUserId: string;
  version: number;
}

interface ResolvedComponent {
  productId: string;
  productNameSnapshot: string;
  productTypeSnapshot: ProductType;
  unitSnapshot: Unit;
  quantity: number;
  unitSalePriceSnapshot: Prisma.Decimal | null;
  priceMode: PosPriceMode;
}

export interface PosConfirmResult {
  cart: PosCartDto;
  orderId: string;
  orderNumber: string;
}

function err(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  status: number = HttpStatus.BAD_REQUEST,
): AppError {
  return new AppError(code, message, details, status);
}

@Injectable()
export class PosCartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly warehouseLock: WarehouseLockService,
    private readonly reservationAllocation: ReservationAllocationService,
    private readonly assembledBouquets: AssembledBouquetService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async createCart(actor: AuthenticatedUser, context: RequestContext = {}): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      const cart = await tx.posCart.create({
        data: { ownerUserId: actor.id, status: PosCartStatus.OPEN },
        include: cartInclude,
      });
      await this.audit.log({
        action: AuditAction.POS_CART_CREATED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cart.id,
        metadata: { version: cart.version },
        context,
        tx,
      });
      return this.toCartDto(cart, tx);
    }, MUTATION_TX);
  }

  /** Own OPEN / PARKED carts (owner-only in stage 1). */
  async listCarts(actor: AuthenticatedUser, status?: PosCartStatus): Promise<PosCartListItem[]> {
    this.assertAccess(actor);
    const rows = await this.prisma.posCart.findMany({
      where: {
        ownerUserId: actor.id,
        status: status ?? { in: [PosCartStatus.OPEN, PosCartStatus.PARKED] },
      },
      include: { _count: { select: { lines: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status as PosCartStatus,
      ownerUserId: r.ownerUserId,
      version: r.version,
      total: decimalToMoneyString(r.total) ?? '0.00',
      lineCount: r._count.lines,
      parkedAt: r.parkedAt?.toISOString() ?? null,
      parkedLabel: r.parkedLabel,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async getCart(actor: AuthenticatedUser, id: string): Promise<PosCartDto> {
    this.assertAccess(actor);
    const cart = await this.prisma.posCart.findUnique({ where: { id }, include: cartInclude });
    if (!cart) throw this.cartNotFound();
    this.assertOwner(actor, cart.ownerUserId);
    return this.toCartDto(cart, this.prisma);
  }

  // ---------------------------------------------------------------------------
  // Lines
  // ---------------------------------------------------------------------------

  async addLine(
    actor: AuthenticatedUser,
    cartId: string,
    dto: AddPosCartLineDto,
    context: RequestContext = {},
  ): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCartForMutation(tx, actor, cartId, dto.expectedVersion);
      let sort = await this.nextSortOrder(tx, cartId);
      const overridden: Array<{ lineId: string; from: string; to: string; reason: string | null }> =
        [];
      const createdIds: string[] = [];

      const create = async (
        data: Omit<Prisma.PosCartLineUncheckedCreateInput, 'cartId' | 'sortOrder'>,
        components: ResolvedComponent[],
      ) => {
        const line = await tx.posCartLine.create({
          data: {
            ...data,
            cartId,
            sortOrder: sort++,
            components: { create: components.map((c, i) => this.toComponentCreate(c, i)) },
          },
        });
        createdIds.push(line.id);
        if (data.priceOverridden) {
          overridden.push({
            lineId: line.id,
            from: (data.recommendedUnitPrice as Prisma.Decimal).toFixed(2),
            to: (data.unitPrice as Prisma.Decimal).toFixed(2),
            reason: (data.priceOverrideReason as string | null | undefined) ?? null,
          });
        }
        return line;
      };

      switch (dto.lineType) {
        case PosCartLineType.PRODUCT:
        case PosCartLineType.SERVICE:
          await this.addProductLine(tx, actor, cartId, dto, create);
          break;
        case PosCartLineType.BOUQUET_TEMPLATE:
          await this.addTemplateLines(tx, actor, dto, create);
          break;
        case PosCartLineType.BOUQUET_CUSTOM:
          await this.addCustomLine(tx, actor, dto, create);
          break;
        case PosCartLineType.ASSEMBLED:
          await this.addAssembledLine(tx, actor, dto, create);
          break;
        default:
          throw err('POS_INVALID_LINE', 'Неизвестный тип позиции');
      }

      await this.finalizeCart(tx, cartId);
      for (const o of overridden) {
        await this.audit.log({
          action: AuditAction.POS_PRICE_OVERRIDDEN,
          actorUserId: actor.id,
          entityType: 'PosCartLine',
          entityId: o.lineId,
          after: { recommendedUnitPrice: o.from, unitPrice: o.to },
          metadata: { cartId, reason: o.reason },
          context,
          tx,
        });
      }
      await this.audit.log({
        action: AuditAction.POS_CART_UPDATED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        metadata: { op: 'ADD_LINE', lineType: dto.lineType, lineIds: createdIds },
        context,
        tx,
      });
      return this.reload(tx, cartId);
    }, MUTATION_TX);
  }

  async updateLine(
    actor: AuthenticatedUser,
    cartId: string,
    lineId: string,
    dto: UpdatePosCartLineDto,
    context: RequestContext = {},
  ): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCartForMutation(tx, actor, cartId, dto.expectedVersion);
      const line = await tx.posCartLine.findFirst({
        where: { id: lineId, cartId },
        include: { components: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!line) {
        throw err('POS_LINE_NOT_FOUND', 'Позиция не найдена', {}, HttpStatus.NOT_FOUND);
      }
      const lineType = line.lineType as PosCartLineType;
      const isBouquet =
        lineType !== PosCartLineType.PRODUCT && lineType !== PosCartLineType.SERVICE;

      if (dto.unitPrice != null && dto.acceptRecommendedPrice) {
        throw err('POS_INVALID_LINE', 'Нельзя одновременно задать цену и принять рекомендованную');
      }

      const data: Prisma.PosCartLineUncheckedUpdateInput = {};

      // quantity
      let quantity = line.quantity;
      if (dto.quantity !== undefined && dto.quantity !== line.quantity) {
        if (isBouquet) {
          throw err(
            'POS_BOUQUET_QUANTITY',
            'Количество букета всегда 1; добавьте ещё один экземпляр',
          );
        }
        quantity = dto.quantity;
        data.quantity = quantity;
      }

      if (dto.nameSnapshot !== undefined) data.nameSnapshot = dto.nameSnapshot;

      // price mode (child SERVICE lines only)
      let priceMode = line.priceMode as PosPriceMode;
      if (dto.priceMode !== undefined && dto.priceMode !== priceMode) {
        if (lineType !== PosCartLineType.SERVICE || !line.parentLineId) {
          throw err(
            'POS_INVALID_PRICE_MODE',
            'Режим цены можно менять только у услуги, привязанной к позиции',
          );
        }
        priceMode = dto.priceMode;
        data.priceMode = priceMode;
      }

      // composition
      let recommended = line.recommendedUnitPrice;
      let compositionChanged = false;
      if (dto.components !== undefined) {
        if (
          lineType !== PosCartLineType.BOUQUET_TEMPLATE &&
          lineType !== PosCartLineType.BOUQUET_CUSTOM
        ) {
          throw err(
            'POS_COMPOSITION_NOT_EDITABLE',
            'Состав можно менять только у букета-шаблона или индивидуального букета',
          );
        }
        const resolved = await this.resolveComponents(tx, dto.components, {
          defaultServiceMode: PosPriceMode.ADDITIONAL,
          requireFlower: true,
          requirePrices: true,
        });
        await tx.posCartLineComponent.deleteMany({ where: { lineId } });
        await tx.posCartLineComponent.createMany({
          data: resolved.map((c, i) => ({ lineId, ...this.toComponentCreate(c, i) })),
        });
        recommended = this.recommendedFor(resolved);
        compositionChanged = true;
        data.recommendedUnitPrice = recommended;
      }

      // unit price
      let unitPrice = line.unitPrice;
      let overridden = line.priceOverridden;
      let reason = line.priceOverrideReason;
      let overriddenBy = line.priceOverriddenByUserId;
      let overrideAudit: { from: string; to: string } | null = null;

      if (dto.acceptRecommendedPrice) {
        unitPrice = recommended;
        overridden = false;
        reason = null;
        overriddenBy = null;
      } else if (dto.unitPrice != null && dto.unitPrice !== '') {
        const next = this.money(dto.unitPrice, 'unitPrice');
        if (!next.equals(recommended) && !next.equals(line.unitPrice)) {
          this.assertPriceOverride(actor);
          overrideAudit = { from: line.unitPrice.toFixed(2), to: next.toFixed(2) };
          overriddenBy = actor.id;
        }
        unitPrice = next;
        overridden = !next.equals(recommended);
        if (!overridden) {
          reason = null;
          overriddenBy = null;
        } else if (dto.priceOverrideReason !== undefined) {
          reason = dto.priceOverrideReason;
        }
      } else if (compositionChanged) {
        if (!overridden) {
          unitPrice = recommended;
        } else {
          overridden = !unitPrice.equals(recommended);
          if (!overridden) {
            reason = null;
            overriddenBy = null;
          }
        }
      } else if (dto.priceOverrideReason !== undefined && overridden) {
        reason = dto.priceOverrideReason;
      }
      data.unitPrice = unitPrice;
      data.priceOverridden = overridden;
      data.priceOverrideReason = reason;
      data.priceOverriddenByUserId = overriddenBy;

      // line discount
      let discountType = line.lineDiscountType as DiscountType | null;
      let discountValue = line.lineDiscountValue;
      if (dto.lineDiscountType !== undefined || dto.lineDiscountValue !== undefined) {
        const nextType = dto.lineDiscountType !== undefined ? dto.lineDiscountType : discountType;
        if (nextType == null) {
          discountType = null;
          discountValue = null;
        } else {
          const rawValue =
            dto.lineDiscountValue !== undefined
              ? dto.lineDiscountValue
              : (discountValue?.toFixed(2) ?? null);
          const parsed = this.parseDiscount(nextType, rawValue);
          this.assertDiscount(actor);
          discountType = parsed.type;
          discountValue = parsed.value;
        }
      }
      data.lineDiscountType = discountType;
      data.lineDiscountValue = discountValue;

      const amounts = this.lineAmounts(priceMode, unitPrice, quantity, discountType, discountValue);
      if (
        discountType === DiscountType.FIXED &&
        discountValue &&
        discountValue.greaterThan(unitPrice.mul(quantity))
      ) {
        throw err('POS_INVALID_DISCOUNT', 'Скидка не может превышать сумму позиции');
      }
      data.lineDiscountAmount = amounts.lineDiscountAmount;
      data.lineSubtotal = amounts.lineSubtotal;

      await tx.posCartLine.update({ where: { id: lineId }, data });
      await this.finalizeCart(tx, cartId);

      if (overrideAudit) {
        await this.audit.log({
          action: AuditAction.POS_PRICE_OVERRIDDEN,
          actorUserId: actor.id,
          entityType: 'PosCartLine',
          entityId: lineId,
          before: { unitPrice: overrideAudit.from },
          after: { unitPrice: overrideAudit.to, recommendedUnitPrice: recommended.toFixed(2) },
          metadata: { cartId, reason },
          context,
          tx,
        });
      }
      await this.audit.log({
        action: AuditAction.POS_CART_UPDATED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        metadata: { op: 'UPDATE_LINE', lineId },
        context,
        tx,
      });
      return this.reload(tx, cartId);
    }, MUTATION_TX);
  }

  async removeLine(
    actor: AuthenticatedUser,
    cartId: string,
    lineId: string,
    expectedVersion?: number,
    context: RequestContext = {},
  ): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCartForMutation(tx, actor, cartId, expectedVersion);
      const line = await tx.posCartLine.findFirst({ where: { id: lineId, cartId } });
      if (!line) {
        throw err('POS_LINE_NOT_FOUND', 'Позиция не найдена', {}, HttpStatus.NOT_FOUND);
      }
      // Child (attached) lines are removed by FK cascade.
      await tx.posCartLine.delete({ where: { id: lineId } });
      await this.finalizeCart(tx, cartId);
      await this.audit.log({
        action: AuditAction.POS_CART_UPDATED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        metadata: { op: 'REMOVE_LINE', lineId, lineType: line.lineType },
        context,
        tx,
      });
      return this.reload(tx, cartId);
    }, MUTATION_TX);
  }

  async updateDiscount(
    actor: AuthenticatedUser,
    cartId: string,
    dto: UpdatePosCartDiscountDto,
    context: RequestContext = {},
  ): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCartForMutation(tx, actor, cartId, dto.expectedVersion);
      let type: DiscountType | null = null;
      let value: Prisma.Decimal | null = null;
      if (dto.discountType) {
        this.assertDiscount(actor);
        const parsed = this.parseDiscount(dto.discountType, dto.discountValue ?? null);
        type = parsed.type;
        value = parsed.value;
        const lines = await tx.posCartLine.findMany({ where: { cartId } });
        const totals = computeCartTotals(
          lines.map((l) => ({
            lineSubtotal: l.lineSubtotal,
            priceMode: l.priceMode,
            parentLineId: l.parentLineId,
          })),
        );
        if (type === DiscountType.FIXED && value.greaterThan(totals.subtotal)) {
          throw err('POS_INVALID_DISCOUNT', 'Скидка не может превышать сумму корзины');
        }
      } else if (dto.discountValue != null && dto.discountValue !== '') {
        throw err('POS_INVALID_DISCOUNT', 'Укажите тип скидки');
      }
      await tx.posCart.update({
        where: { id: cartId },
        data: { discountType: type, discountValue: value },
      });
      await this.finalizeCart(tx, cartId);
      await this.audit.log({
        action: AuditAction.POS_CART_UPDATED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        metadata: {
          op: 'CART_DISCOUNT',
          discountType: type,
          discountValue: value?.toFixed(2) ?? null,
        },
        context,
        tx,
      });
      return this.reload(tx, cartId);
    }, MUTATION_TX);
  }

  // ---------------------------------------------------------------------------
  // Park / resume
  // ---------------------------------------------------------------------------

  async park(
    actor: AuthenticatedUser,
    cartId: string,
    dto: ParkPosCartDto,
    context: RequestContext = {},
  ): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockCartForMutation(tx, actor, cartId, dto.expectedVersion);
      if (locked.status !== PosCartStatus.OPEN) {
        throw err(
          'POS_CART_NOT_OPEN',
          'Отложить можно только открытую корзину',
          {
            status: locked.status,
          },
          HttpStatus.CONFLICT,
        );
      }
      const lineCount = await tx.posCartLine.count({ where: { cartId } });
      if (lineCount === 0) {
        throw err('POS_CART_EMPTY', 'Нельзя отложить пустую корзину');
      }
      await tx.posCart.update({
        where: { id: cartId },
        data: {
          status: PosCartStatus.PARKED,
          parkedAt: new Date(),
          parkedLabel: dto.parkedLabel ?? null,
          version: { increment: 1 },
        },
      });
      await this.audit.log({
        action: AuditAction.POS_CART_PARKED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        metadata: { parkedLabel: dto.parkedLabel ?? null },
        context,
        tx,
      });
      return this.reload(tx, cartId);
    }, MUTATION_TX);
  }

  async resume(
    actor: AuthenticatedUser,
    cartId: string,
    expectedVersion: number,
    context: RequestContext = {},
  ): Promise<PosCartDto> {
    this.assertAccess(actor);
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockCartForMutation(tx, actor, cartId, expectedVersion);
      if (locked.status !== PosCartStatus.PARKED) {
        throw err(
          'POS_CART_NOT_PARKED',
          'Корзина не отложена',
          { status: locked.status },
          HttpStatus.CONFLICT,
        );
      }
      await tx.posCart.update({
        where: { id: cartId },
        data: {
          status: PosCartStatus.OPEN,
          parkedAt: null,
          parkedLabel: null,
          version: { increment: 1 },
        },
      });
      await this.audit.log({
        action: AuditAction.POS_CART_RESUMED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        context,
        tx,
      });
      return this.reload(tx, cartId);
    }, MUTATION_TX);
  }

  // ---------------------------------------------------------------------------
  // Confirm
  // ---------------------------------------------------------------------------

  async confirm(
    actor: AuthenticatedUser,
    cartId: string,
    dto: ConfirmPosCartDto,
    context: RequestContext = {},
  ): Promise<PosConfirmResult> {
    this.assertAccess(actor);
    this.assertSell(actor);
    const key = dto.idempotencyKey.trim();
    if (key.length < 8) {
      throw err(
        'POS_INVALID_IDEMPOTENCY_KEY',
        'idempotencyKey должен содержать минимум 8 символов',
      );
    }

    const pre = await this.prisma.posCart.findUnique({
      where: { id: cartId },
      include: cartInclude,
    });
    if (!pre) throw this.cartNotFound();
    this.assertOwner(actor, pre.ownerUserId);

    const replay = await this.tryReplay(this.prisma, pre, key, cartId);
    if (replay) return replay;
    this.assertMutableStatus(pre.status as PosCartStatus);
    if (pre.version !== dto.expectedVersion)
      throw this.versionConflict(dto.expectedVersion, pre.version);

    const needsWarehouse = pre.lines.some(
      (l) =>
        l.lineType === PosCartLineType.ASSEMBLED ||
        l.lineType === PosCartLineType.PRODUCT ||
        l.components.some((c) => c.productTypeSnapshot === ProductType.FLOWER),
    );

    return this.prisma.$transaction(async (tx) => {
      // Lock order: warehouse advisory → business document rows → stock rows.
      if (needsWarehouse) {
        await this.warehouseLock.beginStockMutation(tx);
      }
      const locked = await this.lockCart(tx, cartId);
      if (locked.status === PosCartStatus.CONFIRMED) {
        const done = await tx.posCart.findUniqueOrThrow({
          where: { id: cartId },
          include: cartInclude,
        });
        const r = await this.tryReplay(tx, done, key, cartId);
        if (r) return r;
      }
      this.assertMutableStatus(locked.status);
      if (locked.version !== pre.version) {
        throw this.versionConflict(dto.expectedVersion, locked.version);
      }

      const cart = await tx.posCart.findUniqueOrThrow({
        where: { id: cartId },
        include: cartInclude,
      });
      if (cart.lines.length === 0) {
        throw err('POS_CART_EMPTY', 'Корзина пуста');
      }

      const mode = dto.fulfillmentMode;
      const today = businessDateString(new Date(), this.config.businessTimeZone);
      const header = this.prepareOrderHeader(dto, mode, today);

      await this.assertLineProductsActive(tx, cart.lines);

      // Lock + validate assembled bouquets (sorted ids, FOR UPDATE).
      const assembledIds = [
        ...new Set(
          cart.lines.map((l) => l.assembledBouquetId).filter((x): x is string => Boolean(x)),
        ),
      ].sort();
      const assembledComponents = new Map<string, ResolvedComponent[]>();
      for (const abId of assembledIds) {
        const rows = await tx.$queryRaw<
          Array<{ id: string; status: string; orderId: string | null; version: number }>
        >`
          SELECT id, status::text AS status, "orderId", version
          FROM assembled_bouquets
          WHERE id = ${abId}
          FOR UPDATE
        `;
        const ab = rows[0];
        if (!ab || ab.status !== AssembledBouquetStatus.ASSEMBLED || ab.orderId) {
          throw err(
            'POS_ASSEMBLED_UNAVAILABLE',
            'Готовый букет уже продан, привязан к заказу или недоступен',
            { assembledBouquetId: abId },
            HttpStatus.CONFLICT,
          );
        }
        assembledComponents.set(abId, await this.loadAssembledComponents(tx, abId));
      }

      // Totals recomputed from persisted lines (authoritative).
      const totals = computeCartTotals(
        cart.lines.map((l) => ({
          lineSubtotal: l.lineSubtotal,
          priceMode: l.priceMode,
          parentLineId: l.parentLineId,
        })),
        cart.discountType,
        cart.discountValue,
      );

      const numberDate = today;
      const seq = await this.nextDailyNumber(tx, numberDate);
      const number = formatOrderNumber(numberDate, seq);

      const order = await tx.order.create({
        data: {
          number,
          numberBusinessDate: parseIsoDateOnly(numberDate),
          status: OrderStatus.NEW,
          source: OrderSource.POS,
          fulfillmentMode: mode,
          paymentStatus: OrderPaymentStatus.UNPAID,
          customerName: header.customerName,
          customerPhone: header.customerPhone,
          fulfillmentType: header.fulfillmentType,
          fulfillmentDate: header.fulfillmentDate,
          fulfillmentTimeFrom: header.fulfillmentTimeFrom,
          fulfillmentTimeTo: header.fulfillmentTimeTo,
          recipientName: header.recipientName,
          recipientPhone: header.recipientPhone,
          deliveryAddressText: header.deliveryAddressText,
          deliveryLatitude: header.deliveryLatitude,
          deliveryLongitude: header.deliveryLongitude,
          deliveryProvider: header.deliveryProvider,
          deliveryProviderPlaceId: header.deliveryProviderPlaceId,
          deliveryComment: header.deliveryComment,
          orderComment: header.orderComment,
          subtotal: totals.subtotal,
          discountType: totals.discountType,
          discountValue: totals.discountValue,
          discountAmount: totals.discountAmount,
          total: totals.total,
          idempotencyKey: key,
          version: 1,
          createdByUserId: actor.id,
        },
      });

      // Order items: roots first, then attached child lines.
      const lines = cart.lines;
      const position = new Map(lines.map((l, i) => [l.id, i] as const));
      const roots = lines.filter((l) => !l.parentLineId);
      const children = lines.filter((l) => l.parentLineId);
      const itemIdByLine = new Map<string, string>();
      let hasFlowerRequirement = false;

      const createItem = async (line: LineRow, parentOrderItemId: string | null) => {
        const lineType = line.lineType as PosCartLineType;
        const isBouquet =
          lineType === PosCartLineType.BOUQUET_TEMPLATE ||
          lineType === PosCartLineType.BOUQUET_CUSTOM ||
          lineType === PosCartLineType.ASSEMBLED;

        const components: Prisma.OrderItemComponentUncheckedCreateWithoutOrderItemInput[] = [];
        if (isBouquet) {
          const source: ResolvedComponent[] =
            lineType === PosCartLineType.ASSEMBLED && line.assembledBouquetId
              ? (assembledComponents.get(line.assembledBouquetId) ?? [])
              : line.components.map((c) => ({
                  productId: c.productId,
                  productNameSnapshot: c.productNameSnapshot,
                  productTypeSnapshot: c.productTypeSnapshot as ProductType,
                  unitSnapshot: c.unitSnapshot as Unit,
                  quantity: c.quantity,
                  unitSalePriceSnapshot: c.unitSalePriceSnapshot,
                  priceMode: c.priceMode as PosPriceMode,
                }));
          source.forEach((c, i) => {
            if (c.productTypeSnapshot === ProductType.FLOWER) hasFlowerRequirement = true;
            components.push({
              productId: c.productId,
              productNameSnapshot: c.productNameSnapshot,
              productTypeSnapshot: c.productTypeSnapshot,
              unitSnapshot: c.unitSnapshot,
              quantityPerItem: c.quantity,
              totalQuantity: c.quantity * line.quantity,
              priceMode: c.priceMode,
              unitSalePriceSnapshot: c.unitSalePriceSnapshot,
              sortOrder: i,
            });
          });
        } else if (lineType === PosCartLineType.PRODUCT) {
          hasFlowerRequirement = true;
        }

        const item = await tx.orderItem.create({
          data: {
            orderId: order.id,
            itemType: isBouquet ? OrderItemType.BOUQUET : OrderItemType.PRODUCT,
            productId: isBouquet ? null : line.productId,
            bouquetId: isBouquet ? line.bouquetTemplateId : null,
            parentOrderItemId,
            priceMode: line.priceMode,
            nameSnapshot: line.nameSnapshot,
            quantity: line.quantity,
            recommendedUnitPrice: line.recommendedUnitPrice,
            unitPrice: line.unitPrice,
            priceOverridden: line.priceOverridden,
            lineDiscountType: line.lineDiscountType,
            lineDiscountValue: line.lineDiscountValue,
            lineDiscountAmount: line.lineDiscountAmount,
            lineSubtotal: line.lineSubtotal,
            sortOrder: position.get(line.id) ?? 0,
            components: { create: components },
          },
        });
        itemIdByLine.set(line.id, item.id);

        if (lineType === PosCartLineType.ASSEMBLED && line.assembledBouquetId) {
          const linked = await tx.assembledBouquet.updateMany({
            where: {
              id: line.assembledBouquetId,
              orderId: null,
              status: AssembledBouquetStatus.ASSEMBLED,
            },
            data: { orderId: order.id, orderItemId: item.id, version: { increment: 1 } },
          });
          if (linked.count === 0) {
            throw err(
              'POS_ASSEMBLED_UNAVAILABLE',
              'Готовый букет уже продан или привязан к заказу',
              { assembledBouquetId: line.assembledBouquetId },
              HttpStatus.CONFLICT,
            );
          }
          await this.audit.log({
            action: AuditAction.BOUQUET_LINKED_TO_ORDER,
            actorUserId: actor.id,
            entityType: 'AssembledBouquet',
            entityId: line.assembledBouquetId,
            metadata: { orderId: order.id, orderItemId: item.id, source: 'POS' },
            context,
            tx,
          });
        }
      };

      for (const line of roots) {
        await createItem(line, null);
      }
      for (const line of children) {
        const parentItemId = itemIdByLine.get(line.parentLineId as string);
        if (!parentItemId) {
          throw err('POS_INVALID_LINE', 'Родительская позиция не найдена', { lineId: line.id });
        }
        await createItem(line, parentItemId);
      }

      // Both WALK_IN and SCHEDULED use planned reserve for unassembled FLOWER needs.
      // AssembledBouquet lines are already in quantityInBouquets — reconcile subtracts them.
      if (hasFlowerRequirement) {
        await this.reservationAllocation.reconcileOrderReservations(tx, order.id);
      }

      // ASSEMBLED-only / fully covered bouquets → READY; partial → IN_PROGRESS.
      // Does not touch paymentStatus.
      await this.assembledBouquets.syncOrderStatusAfterAssembly(tx, order.id, actor.id);

      await tx.posCart.update({
        where: { id: cartId },
        data: {
          status: PosCartStatus.CONFIRMED,
          confirmIdempotencyKey: key,
          confirmedOrderId: order.id,
          confirmedAt: new Date(),
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          total: totals.total,
          version: { increment: 1 },
        },
      });

      await this.audit.log({
        action: AuditAction.POS_CART_CONFIRMED,
        actorUserId: actor.id,
        entityType: 'PosCart',
        entityId: cartId,
        after: {
          orderId: order.id,
          orderNumber: order.number,
          total: totals.total.toFixed(2),
          discountAmount: totals.discountAmount.toFixed(2),
        },
        metadata: {
          orderId: order.id,
          number: order.number,
          fulfillmentMode: mode,
          lineCount: lines.length,
          assembledBouquetIds: assembledIds,
        },
        context,
        tx,
      });

      return {
        cart: await this.reload(tx, cartId),
        orderId: order.id,
        orderNumber: order.number,
      };
    }, CONFIRM_TX);
  }

  // ---------------------------------------------------------------------------
  // addLine helpers
  // ---------------------------------------------------------------------------

  private async addProductLine(
    tx: Tx,
    actor: AuthenticatedUser,
    cartId: string,
    dto: AddPosCartLineDto,
    create: CreateLineFn,
  ): Promise<void> {
    const isService = dto.lineType === PosCartLineType.SERVICE;
    if (!dto.productId) throw err('POS_INVALID_LINE', 'Укажите productId');
    if (dto.bouquetTemplateId || dto.assembledBouquetId) {
      throw err('POS_INVALID_LINE', 'Некорректная товарная позиция');
    }
    const product = await tx.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw err('POS_PRODUCT_NOT_FOUND', 'Товар не найден');
    if (!product.isActive) {
      throw err(
        'POS_INACTIVE_PRODUCT',
        `Товар «${product.name}» неактивен`,
        { productId: product.id },
        HttpStatus.CONFLICT,
      );
    }
    const expectedType = isService ? ProductType.SERVICE : ProductType.FLOWER;
    if (product.type !== expectedType) {
      throw err('POS_INVALID_LINE', `Тип позиции не соответствует типу товара (${product.type})`);
    }
    if (product.salePrice == null) {
      throw err('POS_PRODUCT_NO_PRICE', `У товара «${product.name}» не задана цена продажи`);
    }

    let parentLineId: string | null = null;
    if (dto.parentLineId) {
      if (!isService) {
        throw err('POS_INVALID_LINE', 'К позиции можно привязать только услугу');
      }
      const parent = await tx.posCartLine.findFirst({
        where: { id: dto.parentLineId, cartId },
      });
      if (!parent)
        throw err(
          'POS_LINE_NOT_FOUND',
          'Родительская позиция не найдена',
          {},
          HttpStatus.NOT_FOUND,
        );
      if (parent.parentLineId || parent.lineType === PosCartLineType.SERVICE) {
        throw err('POS_INVALID_LINE', 'Услугу можно привязать только к товару или букету');
      }
      parentLineId = parent.id;
    }

    let priceMode = dto.priceMode ?? PosPriceMode.ADDITIONAL;
    if (priceMode === PosPriceMode.INCLUDED && !parentLineId) {
      throw err(
        'POS_INVALID_PRICE_MODE',
        'INCLUDED допустим только для услуги, привязанной к позиции',
      );
    }
    if (!isService) priceMode = PosPriceMode.ADDITIONAL;

    const quantity = dto.quantity ?? 1;
    const recommended = product.salePrice;
    const price = this.resolveUnitPrice(actor, recommended, dto.unitPrice, dto.priceOverrideReason);
    const amounts = this.lineAmounts(priceMode, price.unitPrice, quantity, null, null);

    await create(
      {
        lineType: dto.lineType,
        productId: product.id,
        parentLineId,
        priceMode,
        nameSnapshot: product.name,
        quantity,
        recommendedUnitPrice: recommended,
        unitPrice: price.unitPrice,
        priceOverridden: price.overridden,
        priceOverrideReason: price.reason,
        priceOverriddenByUserId: price.overridden ? actor.id : null,
        lineDiscountAmount: amounts.lineDiscountAmount,
        lineSubtotal: amounts.lineSubtotal,
      },
      [],
    );
  }

  private async addTemplateLines(
    tx: Tx,
    actor: AuthenticatedUser,
    dto: AddPosCartLineDto,
    create: CreateLineFn,
  ): Promise<void> {
    if (!dto.bouquetTemplateId) throw err('POS_INVALID_LINE', 'Укажите bouquetTemplateId');
    if (dto.productId || dto.assembledBouquetId || dto.parentLineId) {
      throw err('POS_INVALID_LINE', 'Некорректная позиция букета');
    }
    const bouquet = await tx.bouquet.findUnique({
      where: { id: dto.bouquetTemplateId },
      include: {
        items: {
          include: { product: true },
          orderBy: [{ product: { type: 'asc' } }, { product: { name: 'asc' } }],
        },
      },
    });
    if (!bouquet) throw err('POS_BOUQUET_NOT_FOUND', 'Букет не найден');
    if (!bouquet.isActive) {
      throw err(
        'POS_INACTIVE_BOUQUET',
        `Букет «${bouquet.name}» неактивен`,
        { bouquetId: bouquet.id },
        HttpStatus.CONFLICT,
      );
    }

    let components: ResolvedComponent[];
    let recommended: Prisma.Decimal;
    if (dto.components?.length) {
      components = await this.resolveComponents(tx, dto.components, {
        defaultServiceMode: PosPriceMode.ADDITIONAL,
        requireFlower: true,
        requirePrices: true,
      });
      recommended = this.recommendedFor(components);
    } else {
      // Template salePrice is authoritative; template SERVICE components are INCLUDED by default.
      components = bouquet.items.map((bi) => ({
        productId: bi.productId,
        productNameSnapshot: bi.product.name,
        productTypeSnapshot: bi.product.type as ProductType,
        unitSnapshot: bi.product.unit as Unit,
        quantity: bi.quantity,
        unitSalePriceSnapshot: bi.product.salePrice,
        priceMode:
          bi.product.type === ProductType.SERVICE ? PosPriceMode.INCLUDED : PosPriceMode.ADDITIONAL,
      }));
      recommended = bouquet.salePrice;
    }

    const price = this.resolveUnitPrice(actor, recommended, dto.unitPrice, dto.priceOverrideReason);
    const amounts = this.lineAmounts(PosPriceMode.ADDITIONAL, price.unitPrice, 1, null, null);
    const copies = dto.copies ?? 1;
    for (let i = 0; i < copies; i++) {
      await create(
        {
          lineType: PosCartLineType.BOUQUET_TEMPLATE,
          bouquetTemplateId: bouquet.id,
          priceMode: PosPriceMode.ADDITIONAL,
          nameSnapshot: dto.nameSnapshot?.trim() || bouquet.name,
          quantity: 1,
          recommendedUnitPrice: recommended,
          unitPrice: price.unitPrice,
          priceOverridden: price.overridden,
          priceOverrideReason: price.reason,
          priceOverriddenByUserId: price.overridden ? actor.id : null,
          lineDiscountAmount: amounts.lineDiscountAmount,
          lineSubtotal: amounts.lineSubtotal,
        },
        components,
      );
    }
  }

  private async addCustomLine(
    tx: Tx,
    actor: AuthenticatedUser,
    dto: AddPosCartLineDto,
    create: CreateLineFn,
  ): Promise<void> {
    if (dto.productId || dto.bouquetTemplateId || dto.assembledBouquetId || dto.parentLineId) {
      throw err('POS_INVALID_LINE', 'Некорректная позиция индивидуального букета');
    }
    if (!dto.components?.length) {
      throw err('POS_COMPOSITION_REQUIRED', 'Укажите состав букета');
    }
    const components = await this.resolveComponents(tx, dto.components, {
      defaultServiceMode: PosPriceMode.ADDITIONAL,
      requireFlower: true,
      requirePrices: true,
    });
    const recommended = this.recommendedFor(components);
    const price = this.resolveUnitPrice(actor, recommended, dto.unitPrice, dto.priceOverrideReason);
    const amounts = this.lineAmounts(PosPriceMode.ADDITIONAL, price.unitPrice, 1, null, null);
    await create(
      {
        lineType: PosCartLineType.BOUQUET_CUSTOM,
        priceMode: PosPriceMode.ADDITIONAL,
        nameSnapshot: dto.nameSnapshot?.trim() || 'Индивидуальный букет',
        quantity: 1,
        recommendedUnitPrice: recommended,
        unitPrice: price.unitPrice,
        priceOverridden: price.overridden,
        priceOverrideReason: price.reason,
        priceOverriddenByUserId: price.overridden ? actor.id : null,
        lineDiscountAmount: amounts.lineDiscountAmount,
        lineSubtotal: amounts.lineSubtotal,
      },
      components,
    );
  }

  private async addAssembledLine(
    tx: Tx,
    actor: AuthenticatedUser,
    dto: AddPosCartLineDto,
    create: CreateLineFn,
  ): Promise<void> {
    if (!dto.assembledBouquetId) throw err('POS_INVALID_LINE', 'Укажите assembledBouquetId');
    if (dto.productId || dto.bouquetTemplateId || dto.parentLineId) {
      throw err('POS_INVALID_LINE', 'Некорректная позиция готового букета');
    }
    const ab = await tx.assembledBouquet.findUnique({
      where: { id: dto.assembledBouquetId },
      include: { bouquetTemplate: { select: { id: true, salePrice: true } } },
    });
    if (!ab)
      throw err('POS_ASSEMBLED_NOT_FOUND', 'Готовый букет не найден', {}, HttpStatus.NOT_FOUND);
    if (ab.status !== AssembledBouquetStatus.ASSEMBLED || ab.orderId) {
      throw err(
        'POS_ASSEMBLED_UNAVAILABLE',
        'Продать можно только собранный букет без привязки к заказу',
        { status: ab.status, orderId: ab.orderId },
        HttpStatus.CONFLICT,
      );
    }
    // Soft conflict: already sitting in another OPEN/PARKED cart (or this one).
    const existing = await tx.posCartLine.findFirst({
      where: {
        assembledBouquetId: ab.id,
        cart: { status: { in: [PosCartStatus.OPEN, PosCartStatus.PARKED] } },
      },
      select: { id: true, cartId: true },
    });
    if (existing) {
      throw err(
        'POS_ASSEMBLED_IN_CART',
        'Этот готовый букет уже добавлен в другую корзину',
        { cartId: existing.cartId },
        HttpStatus.CONFLICT,
      );
    }

    const components = await this.loadAssembledComponents(tx, ab.id);
    const recommended = ab.bouquetTemplate
      ? ab.bouquetTemplate.salePrice
      : this.recommendedFor(components);
    const price = this.resolveUnitPrice(actor, recommended, dto.unitPrice, dto.priceOverrideReason);
    const amounts = this.lineAmounts(PosPriceMode.ADDITIONAL, price.unitPrice, 1, null, null);
    await create(
      {
        lineType: PosCartLineType.ASSEMBLED,
        assembledBouquetId: ab.id,
        bouquetTemplateId: ab.bouquetTemplate?.id ?? null,
        priceMode: PosPriceMode.ADDITIONAL,
        nameSnapshot: ab.nameSnapshot,
        quantity: 1,
        recommendedUnitPrice: recommended,
        unitPrice: price.unitPrice,
        priceOverridden: price.overridden,
        priceOverrideReason: price.reason,
        priceOverriddenByUserId: price.overridden ? actor.id : null,
        lineDiscountAmount: amounts.lineDiscountAmount,
        lineSubtotal: amounts.lineSubtotal,
      },
      components,
    );
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private recommendedFor(components: ResolvedComponent[]): Prisma.Decimal {
    return computeComponentRecommended(
      components.map((c) => ({
        productType: c.productTypeSnapshot,
        quantity: c.quantity,
        unitSalePrice: c.unitSalePriceSnapshot,
        priceMode: c.priceMode,
      })),
    );
  }

  private lineAmounts(
    priceMode: PosPriceMode,
    unitPrice: Prisma.Decimal,
    quantity: number,
    discountType: DiscountType | null,
    discountValue: Prisma.Decimal | null,
  ): PosLineAmounts {
    if (priceMode === PosPriceMode.INCLUDED) {
      // Covered by a parent price: contributes 0 to money.
      return { lineDiscountAmount: new Prisma.Decimal(0), lineSubtotal: new Prisma.Decimal(0) };
    }
    return computeLineSubtotal(unitPrice, quantity, discountType, discountValue);
  }

  private resolveUnitPrice(
    actor: AuthenticatedUser,
    recommended: Prisma.Decimal,
    rawUnitPrice: string | null | undefined,
    reason: string | null | undefined,
  ): {
    unitPrice: Prisma.Decimal;
    overridden: boolean;
    reason: string | null;
  } {
    if (rawUnitPrice == null || rawUnitPrice === '') {
      return { unitPrice: recommended, overridden: false, reason: null };
    }
    const price = this.money(rawUnitPrice, 'unitPrice');
    if (price.equals(recommended)) {
      return { unitPrice: recommended, overridden: false, reason: null };
    }
    this.assertPriceOverride(actor);
    return { unitPrice: price, overridden: true, reason: reason?.trim() || null };
  }

  private async resolveComponents(
    tx: Tx,
    inputs: PosCartComponentInputDto[],
    opts: {
      defaultServiceMode: PosPriceMode;
      requireFlower: boolean;
      requirePrices: boolean;
    },
  ): Promise<ResolvedComponent[]> {
    if (!inputs.length) {
      throw err('POS_COMPOSITION_REQUIRED', 'Укажите состав букета');
    }
    // Merge duplicates by product (sum quantity; last explicit priceMode wins).
    const merged = new Map<string, { quantity: number; priceMode?: PosPriceMode }>();
    for (const c of inputs) {
      const cur = merged.get(c.productId);
      merged.set(c.productId, {
        quantity: (cur?.quantity ?? 0) + c.quantity,
        priceMode: c.priceMode ?? cur?.priceMode,
      });
    }
    const products = await tx.product.findMany({ where: { id: { in: [...merged.keys()] } } });
    const byId = new Map(products.map((p) => [p.id, p] as const));
    const out: ResolvedComponent[] = [];
    for (const [productId, v] of merged) {
      const p = byId.get(productId);
      if (!p) throw err('POS_PRODUCT_NOT_FOUND', 'Компонент не найден', { productId });
      if (!p.isActive) {
        throw err(
          'POS_INACTIVE_PRODUCT',
          `Товар «${p.name}» неактивен`,
          { productId },
          HttpStatus.CONFLICT,
        );
      }
      const type = p.type as ProductType;
      if (opts.requirePrices && p.salePrice == null) {
        throw err('POS_PRODUCT_NO_PRICE', `У товара «${p.name}» не задана цена продажи`, {
          productId,
        });
      }
      out.push({
        productId,
        productNameSnapshot: p.name,
        productTypeSnapshot: type,
        unitSnapshot: p.unit as Unit,
        quantity: v.quantity,
        unitSalePriceSnapshot: p.salePrice,
        priceMode:
          type === ProductType.SERVICE
            ? (v.priceMode ?? opts.defaultServiceMode)
            : PosPriceMode.ADDITIONAL,
      });
    }
    if (opts.requireFlower && !out.some((c) => c.productTypeSnapshot === ProductType.FLOWER)) {
      throw err('POS_COMPOSITION_REQUIRES_FLOWER', 'В составе букета нужен хотя бы один цветок');
    }
    return out;
  }

  private async loadAssembledComponents(
    tx: Tx,
    assembledBouquetId: string,
  ): Promise<ResolvedComponent[]> {
    const rows = await tx.assembledBouquetComponent.findMany({
      where: { assembledBouquetId },
      include: { product: true },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((r) => ({
      productId: r.productId,
      productNameSnapshot: r.productNameSnapshot,
      productTypeSnapshot: r.product.type as ProductType,
      unitSnapshot: r.product.unit as Unit,
      quantity: r.quantity,
      unitSalePriceSnapshot: r.product.salePrice,
      priceMode: PosPriceMode.ADDITIONAL,
    }));
  }

  private toComponentCreate(
    c: ResolvedComponent,
    index: number,
  ): Prisma.PosCartLineComponentUncheckedCreateWithoutLineInput {
    return {
      productId: c.productId,
      productNameSnapshot: c.productNameSnapshot,
      productTypeSnapshot: c.productTypeSnapshot,
      unitSnapshot: c.unitSnapshot,
      quantity: c.quantity,
      unitSalePriceSnapshot: c.unitSalePriceSnapshot,
      priceMode: c.priceMode,
      sortOrder: index,
    };
  }

  private async nextSortOrder(tx: Tx, cartId: string): Promise<number> {
    const agg = await tx.posCartLine.aggregate({ where: { cartId }, _max: { sortOrder: true } });
    return (agg._max.sortOrder ?? -1) + 1;
  }

  /** Recompute totals from persisted lines and bump cart version. */
  private async finalizeCart(tx: Tx, cartId: string): Promise<void> {
    const cart = await tx.posCart.findUniqueOrThrow({
      where: { id: cartId },
      include: { lines: true },
    });
    const totals = computeCartTotals(
      cart.lines.map((l) => ({
        lineSubtotal: l.lineSubtotal,
        priceMode: l.priceMode,
        parentLineId: l.parentLineId,
      })),
      cart.discountType,
      cart.discountValue,
    );
    await tx.posCart.update({
      where: { id: cartId },
      data: {
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        total: totals.total,
        version: { increment: 1 },
      },
    });
  }

  private async reload(tx: Tx, cartId: string): Promise<PosCartDto> {
    const cart = await tx.posCart.findUniqueOrThrow({
      where: { id: cartId },
      include: cartInclude,
    });
    return this.toCartDto(cart, tx);
  }

  private async lockCart(tx: Tx, cartId: string): Promise<LockedCart> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; status: string; ownerUserId: string; version: number }>
    >`
      SELECT id, status::text AS status, "ownerUserId", version
      FROM pos_carts
      WHERE id = ${cartId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw this.cartNotFound();
    return {
      id: row.id,
      status: row.status as PosCartStatus,
      ownerUserId: row.ownerUserId,
      version: row.version,
    };
  }

  /** Lock row, enforce owner + mutable status + optional CAS on version. */
  private async lockCartForMutation(
    tx: Tx,
    actor: AuthenticatedUser,
    cartId: string,
    expectedVersion?: number,
  ): Promise<LockedCart> {
    const locked = await this.lockCart(tx, cartId);
    this.assertOwner(actor, locked.ownerUserId);
    this.assertMutableStatus(locked.status);
    if (expectedVersion !== undefined && locked.version !== expectedVersion) {
      throw this.versionConflict(expectedVersion, locked.version);
    }
    return locked;
  }

  private assertMutableStatus(status: PosCartStatus): void {
    if (status === PosCartStatus.CONFIRMED || status === PosCartStatus.CANCELLED) {
      throw err(
        'POS_CART_NOT_EDITABLE',
        'Корзина оформлена или отменена и не может быть изменена',
        { status },
        HttpStatus.CONFLICT,
      );
    }
  }

  private async tryReplay(
    db: Db,
    cart: CartRow,
    key: string,
    cartId: string,
  ): Promise<PosConfirmResult | null> {
    if (cart.status === PosCartStatus.CONFIRMED) {
      if (cart.confirmIdempotencyKey === key && cart.confirmedOrderId) {
        const order = await db.order.findUniqueOrThrow({
          where: { id: cart.confirmedOrderId },
          select: { id: true, number: true },
        });
        return {
          cart: await this.toCartDto(cart, db),
          orderId: order.id,
          orderNumber: order.number,
        };
      }
      throw err(
        'POS_CART_ALREADY_CONFIRMED',
        'Корзина уже оформлена с другим ключом идемпотентности',
        { orderId: cart.confirmedOrderId },
        HttpStatus.CONFLICT,
      );
    }
    const clash = await db.order.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, posCart: { select: { id: true } } },
    });
    if (clash && clash.posCart?.id !== cartId) {
      throw err(
        'POS_IDEMPOTENCY_KEY_REUSED',
        'Ключ идемпотентности уже использован для другой операции',
        {},
        HttpStatus.CONFLICT,
      );
    }
    return null;
  }

  private async assertLineProductsActive(tx: Tx, lines: LineRow[]): Promise<void> {
    const ids = new Set<string>();
    for (const l of lines) {
      if (l.productId) ids.add(l.productId);
      // Assembled bouquets are physical; their components are already consumed.
      if (l.lineType === PosCartLineType.ASSEMBLED) continue;
      for (const c of l.components) ids.add(c.productId);
    }
    if (!ids.size) return;
    const inactive = await tx.product.findMany({
      where: { id: { in: [...ids] }, isActive: false },
      select: { id: true, name: true },
    });
    if (inactive.length) {
      throw err(
        'POS_INACTIVE_PRODUCT',
        `Товар «${inactive[0]!.name}» неактивен`,
        { productIds: inactive.map((p) => p.id) },
        HttpStatus.CONFLICT,
      );
    }
  }

  private prepareOrderHeader(dto: ConfirmPosCartDto, mode: OrderFulfillmentMode, today: string) {
    const customerName = (dto.customerName ?? '').trim();
    const orderComment = dto.orderComment?.trim() || null;

    if (mode === OrderFulfillmentMode.WALK_IN) {
      return {
        customerName,
        customerPhone: (dto.customerPhone ?? '').trim(),
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: parseIsoDateOnly(today),
        fulfillmentTimeFrom: null as string | null,
        fulfillmentTimeTo: null as string | null,
        recipientName: null as string | null,
        recipientPhone: null as string | null,
        deliveryAddressText: null as string | null,
        deliveryLatitude: null as Prisma.Decimal | null,
        deliveryLongitude: null as Prisma.Decimal | null,
        deliveryProvider: null as string | null,
        deliveryProviderPlaceId: null as string | null,
        deliveryComment: null as string | null,
        orderComment,
      };
    }

    // SCHEDULED
    const phone = (dto.customerPhone ?? '').trim();
    if (phone.length < 3) {
      throw err('POS_PHONE_REQUIRED', 'Для предзаказа укажите телефон клиента');
    }
    if (!dto.fulfillmentDate) {
      throw err('POS_DATE_REQUIRED', 'Для предзаказа укажите дату выполнения');
    }
    const isoDate = dto.fulfillmentDate.slice(0, 10);
    let fulfillmentDate: Date;
    try {
      fulfillmentDate = parseIsoDateOnly(isoDate);
    } catch {
      throw err('POS_INVALID_DATE', 'Некорректная дата выполнения');
    }
    const timeFrom = dto.fulfillmentTimeFrom?.trim() || null;
    const timeTo = dto.fulfillmentTimeTo?.trim() || null;
    if (timeFrom && !isValidHm(timeFrom)) {
      throw err('ORDER_INVALID_TIME', 'Некорректное время начала');
    }
    if (timeTo && !isValidHm(timeTo)) {
      throw err('ORDER_INVALID_TIME', 'Некорректное время окончания');
    }
    if (timeTo && !timeFrom) {
      throw err('ORDER_INVALID_TIME', 'Если указано время «до», нужно указать время «с»');
    }
    if (timeFrom && timeTo && compareHm(timeTo, timeFrom) < 0) {
      throw err('ORDER_INVALID_TIME', 'Время «до» не может быть раньше времени «с»');
    }

    const fulfillmentType = dto.fulfillmentType ?? FulfillmentType.PICKUP;
    let recipientName = dto.recipientName?.trim() || null;
    let recipientPhone = dto.recipientPhone?.trim() || null;
    let deliveryAddressText = dto.deliveryAddressText?.trim() || null;
    let deliveryLatitude =
      dto.deliveryLatitude == null ? null : new Prisma.Decimal(dto.deliveryLatitude);
    let deliveryLongitude =
      dto.deliveryLongitude == null ? null : new Prisma.Decimal(dto.deliveryLongitude);
    let deliveryProvider = dto.deliveryProvider?.trim() || null;
    let deliveryProviderPlaceId = dto.deliveryProviderPlaceId?.trim() || null;
    let deliveryComment = dto.deliveryComment?.trim() || null;
    if (fulfillmentType === FulfillmentType.PICKUP) {
      recipientName = null;
      recipientPhone = null;
      deliveryAddressText = null;
      deliveryLatitude = null;
      deliveryLongitude = null;
      deliveryProvider = null;
      deliveryProviderPlaceId = null;
      deliveryComment = null;
    } else if (!deliveryAddressText) {
      throw err('ORDER_INVALID_FULFILLMENT', 'Для доставки укажите адрес');
    }

    return {
      customerName,
      customerPhone: phone,
      fulfillmentType,
      fulfillmentDate,
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
      orderComment,
    };
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
      throw err(
        'INTERNAL_ERROR',
        'Не удалось выделить номер заказа',
        {},
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return value;
  }

  // --- validation / permissions ---------------------------------------------

  private money(raw: string, field: string): Prisma.Decimal {
    try {
      const v = parseMoneyInput(raw);
      if (!v) throw new Error('INVALID_MONEY');
      return v;
    } catch {
      throw err('POS_INVALID_MONEY', 'Некорректная сумма', { field });
    }
  }

  private parseDiscount(
    type: DiscountType,
    rawValue: string | null,
  ): { type: DiscountType; value: Prisma.Decimal } {
    if (rawValue == null || rawValue === '') {
      throw err('POS_INVALID_DISCOUNT', 'Укажите величину скидки');
    }
    let value: Prisma.Decimal;
    try {
      value = this.money(rawValue, 'discountValue');
    } catch {
      throw err('POS_INVALID_DISCOUNT', 'Некорректная скидка');
    }
    if (type === DiscountType.PERCENT && value.greaterThan(100)) {
      throw err('POS_INVALID_DISCOUNT', 'Процент скидки должен быть от 0 до 100');
    }
    return { type, value };
  }

  private can(actor: AuthenticatedUser, ...permissions: Permission[]): boolean {
    return permissions.some((p) => roleHasPermission(actor.role as Role, p));
  }

  private forbidden(message: string): AppError {
    return new AppError('FORBIDDEN', message, {}, HttpStatus.FORBIDDEN);
  }

  private assertAccess(actor: AuthenticatedUser): void {
    if (!this.can(actor, Permission.POS_ACCESS)) {
      throw this.forbidden('Недостаточно прав для работы с кассой');
    }
  }

  private assertSell(actor: AuthenticatedUser): void {
    if (!this.can(actor, Permission.POS_SELL)) {
      throw this.forbidden('Недостаточно прав для оформления продажи');
    }
  }

  private assertPriceOverride(actor: AuthenticatedUser): void {
    if (!this.can(actor, Permission.POS_PRICE_OVERRIDE, Permission.ORDERS_DISCOUNT)) {
      throw this.forbidden('Недостаточно прав для изменения цены');
    }
  }

  private assertDiscount(actor: AuthenticatedUser): void {
    if (!this.can(actor, Permission.POS_DISCOUNT, Permission.ORDERS_DISCOUNT)) {
      throw this.forbidden('Недостаточно прав для скидки');
    }
  }

  private assertOwner(actor: AuthenticatedUser, ownerUserId: string): void {
    if (ownerUserId !== actor.id) {
      throw this.forbidden('Корзина принадлежит другому сотруднику');
    }
  }

  private cartNotFound(): AppError {
    return err('POS_CART_NOT_FOUND', 'Корзина не найдена', {}, HttpStatus.NOT_FOUND);
  }

  private versionConflict(expected: number, current: number): AppError {
    return err(
      'POS_CART_CONFLICT',
      'Корзина была изменена. Обновите страницу.',
      { expectedVersion: expected, currentVersion: current },
      HttpStatus.CONFLICT,
    );
  }

  // --- DTO mapping ----------------------------------------------------------

  private async toCartDto(cart: CartRow, db: Db): Promise<PosCartDto> {
    const flowerIds = [
      ...new Set(
        cart.lines.flatMap((l) =>
          l.components
            .filter((c) => c.productTypeSnapshot === ProductType.FLOWER)
            .map((c) => c.productId),
        ),
      ),
    ];
    const stocks = flowerIds.length
      ? await db.productStock.findMany({ where: { productId: { in: flowerIds } } })
      : [];
    const available = new Map(
      stocks.map((s) => [s.productId, s.quantityOnHand - s.quantityReserved] as const),
    );

    const toLine = (l: LineRow): PosCartLineDto => ({
      id: l.id,
      lineType: l.lineType as PosCartLineType,
      productId: l.productId,
      bouquetTemplateId: l.bouquetTemplateId,
      assembledBouquetId: l.assembledBouquetId,
      parentLineId: l.parentLineId,
      priceMode: l.priceMode as PosPriceMode,
      nameSnapshot: l.nameSnapshot,
      quantity: l.quantity,
      recommendedUnitPrice: decimalToMoneyString(l.recommendedUnitPrice) ?? '0.00',
      unitPrice: decimalToMoneyString(l.unitPrice) ?? '0.00',
      priceOverridden: l.priceOverridden,
      priceOverrideReason: l.priceOverrideReason,
      lineDiscountType: l.lineDiscountType as DiscountType | null,
      lineDiscountValue: decimalToMoneyString(l.lineDiscountValue),
      lineDiscountAmount: decimalToMoneyString(l.lineDiscountAmount) ?? '0.00',
      lineSubtotal: decimalToMoneyString(l.lineSubtotal) ?? '0.00',
      sortOrder: l.sortOrder,
      components: l.components.map<PosCartLineComponentDto>((c) => ({
        id: c.id,
        productId: c.productId,
        productNameSnapshot: c.productNameSnapshot,
        productTypeSnapshot: c.productTypeSnapshot as ProductType,
        unitSnapshot: c.unitSnapshot as Unit,
        quantity: c.quantity,
        unitSalePriceSnapshot: decimalToMoneyString(c.unitSalePriceSnapshot),
        priceMode: c.priceMode as PosPriceMode,
        availableQuantity:
          c.productTypeSnapshot === ProductType.FLOWER ? (available.get(c.productId) ?? 0) : null,
        sortOrder: c.sortOrder,
      })),
      childLines: [],
    });

    const dtoById = new Map(cart.lines.map((l) => [l.id, toLine(l)] as const));
    const roots: PosCartLineDto[] = [];
    for (const l of cart.lines) {
      const dto = dtoById.get(l.id)!;
      const parent = l.parentLineId ? dtoById.get(l.parentLineId) : undefined;
      if (parent) parent.childLines.push(dto);
      else roots.push(dto);
    }

    return {
      id: cart.id,
      status: cart.status as PosCartStatus,
      ownerUserId: cart.ownerUserId,
      version: cart.version,
      discountType: cart.discountType as DiscountType | null,
      discountValue: decimalToMoneyString(cart.discountValue),
      discountAmount: decimalToMoneyString(cart.discountAmount) ?? '0.00',
      subtotal: decimalToMoneyString(cart.subtotal) ?? '0.00',
      total: decimalToMoneyString(cart.total) ?? '0.00',
      parkedAt: cart.parkedAt?.toISOString() ?? null,
      parkedLabel: cart.parkedLabel,
      confirmedOrderId: cart.confirmedOrderId,
      confirmedAt: cart.confirmedAt?.toISOString() ?? null,
      createdAt: cart.createdAt.toISOString(),
      updatedAt: cart.updatedAt.toISOString(),
      lines: roots,
    };
  }
}

type CreateLineFn = (
  data: Omit<Prisma.PosCartLineUncheckedCreateInput, 'cartId' | 'sortOrder'>,
  components: ResolvedComponent[],
) => Promise<{ id: string }>;
