import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssembledBouquetStatus,
  AuditAction,
  OrderFulfillmentMode,
  OrderItemType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentSource,
  Permission,
  PosCartStatus,
  Role,
  roleHasPermission,
  type PosQuickSellResultDto,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AssembledBouquetService } from '../warehouse/assembled-bouquet.service';
import { CashShiftService } from '../cash/cash-shift.service';
import { PaymentsService } from '../payments/payments.service';
import { paymentInclude, toPaymentDto } from '../payments/payment-mapper';
import { parseMoneyInput } from '../products/product-mapper';
import { PosCartService } from './pos-cart.service';
import { QuickSellDto } from './dto/pos.dto';

const PAY_TX = { maxWait: 10_000, timeout: 30_000 } as const;

function err(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  status: number = HttpStatus.BAD_REQUEST,
): AppError {
  return new AppError(code, message, details, status);
}

/**
 * «Оплатить и выдать»: confirm cart → register CONFIRMED payments → issue goods.
 *
 * Deliberately NOT one giant transaction: payments and stock issue are independent
 * documents. A stock failure must leave the order paid (and not completed) with a warning,
 * never roll back money that was physically taken.
 *
 * Retry-safe: the quick-sell key is the cart confirm key; every payment has its own key;
 * issue skips whatever is already issued.
 */
@Injectable()
export class PosQuickSellService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carts: PosCartService,
    private readonly payments: PaymentsService,
    private readonly cash: CashShiftService,
    private readonly assembled: AssembledBouquetService,
  ) {}

  async quickSell(
    actor: AuthenticatedUser,
    cartId: string,
    dto: QuickSellDto,
    context: RequestContext = {},
  ): Promise<PosQuickSellResultDto> {
    this.assertPermission(actor, Permission.POS_ACCESS);
    this.assertPermission(actor, Permission.POS_SELL);
    this.assertPermission(actor, Permission.PAYMENTS_CREATE);
    const wantIssue = dto.issue !== false;
    if (wantIssue) this.assertPermission(actor, Permission.ORDERS_ISSUE);

    const key = dto.idempotencyKey.trim();
    const parsed = dto.payments.map((p) => ({
      method: p.method,
      amount: this.positiveMoney(p.amount),
      idempotencyKey: p.idempotencyKey.trim(),
    }));
    const keys = new Set(parsed.map((p) => p.idempotencyKey));
    if (keys.size !== parsed.length) {
      throw err('PAYMENT_DUPLICATE_KEYS', 'У платежей должны быть разные ключи идемпотентности');
    }

    const cart = await this.prisma.posCart.findUnique({
      where: { id: cartId },
      select: { id: true, ownerUserId: true, status: true, confirmedOrderId: true },
    });
    if (!cart) {
      throw err('POS_CART_NOT_FOUND', 'Корзина не найдена', {}, HttpStatus.NOT_FOUND);
    }
    if (cart.ownerUserId !== actor.id) {
      throw new AppError('FORBIDDEN', 'Корзина принадлежит другому сотруднику', {}, HttpStatus.FORBIDDEN);
    }

    // Fail before any state change when cash cannot be accepted.
    if (parsed.some((p) => p.method === PaymentMethod.CASH)) {
      const shift = await this.cash.getCurrent();
      if (!shift) {
        throw err(
          'CASH_SHIFT_REQUIRED',
          'Для приёма наличных откройте кассовую смену',
          {},
          HttpStatus.CONFLICT,
        );
      }
    }

    // 1) confirm (or reuse the order of an already confirmed cart)
    let orderId: string;
    if (cart.status === PosCartStatus.CONFIRMED && cart.confirmedOrderId) {
      orderId = cart.confirmedOrderId;
    } else {
      const confirmed = await this.carts.confirm(
        actor,
        cartId,
        {
          expectedVersion: dto.expectedVersion,
          idempotencyKey: key,
          fulfillmentMode: OrderFulfillmentMode.WALK_IN,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
          orderComment: dto.orderComment,
        },
        context,
      );
      orderId = confirmed.orderId;
    }

    // 2) payments (one tx; per-order row lock serializes against concurrent payers)
    let newPayments = 0;
    if (parsed.length) {
      newPayments = await this.prisma.$transaction(async (tx) => {
        let created = 0;
        for (const p of parsed) {
          const r = await this.payments.createChargeInTx(
            tx,
            actor,
            orderId,
            {
              amount: p.amount,
              method: p.method,
              source: PaymentSource.POS,
              idempotencyKey: p.idempotencyKey,
              confirmImmediately: true,
              // POS terminal entry is staff-recorded; there is no provider callback.
              isManual: p.method !== PaymentMethod.CASH,
              trusted: true,
              note: 'POS quick-sell',
              metadata: { quickSellKey: key },
            },
            context,
          );
          if (!r.replayed) created++;
        }
        return created;
      }, PAY_TX);
    }

    const warnings: string[] = [];
    const afterPay = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paymentStatus: true },
    });
    const fullyPaid = afterPay.paymentStatus === OrderPaymentStatus.PAID;

    // 3) issue
    let issuedSomething = false;
    if (wantIssue) {
      if (!fullyPaid) {
        warnings.push('Заказ оплачен не полностью — выдача не выполнена');
      } else {
        const res = await this.issueAll(actor, orderId, context);
        issuedSomething = res.issued > 0;
        warnings.push(...res.warnings);
      }
    }

    // 4) result
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, number: true, status: true, paymentStatus: true, total: true },
    });
    const paymentRows = await this.prisma.payment.findMany({
      where: { orderId },
      include: paymentInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const completed = order.status === OrderStatus.COMPLETED;

    if (newPayments > 0 || issuedSomething) {
      await this.audit.log({
        action: AuditAction.POS_QUICK_SALE_COMPLETED,
        actorUserId: actor.id,
        entityType: 'Order',
        entityId: orderId,
        metadata: {
          cartId,
          orderNumber: order.number,
          newPayments,
          paymentStatus: order.paymentStatus,
          orderStatus: order.status,
          completed,
          warnings,
        },
        context,
      });
    }

    return {
      cart: await this.carts.getCart(actor, cartId),
      orderId,
      orderNumber: order.number,
      paymentStatus: order.paymentStatus as OrderPaymentStatus,
      orderStatus: order.status as OrderStatus,
      payments: paymentRows.map((p) => toPaymentDto(p)),
      issued: completed,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Issue ASSEMBLED bouquets (AssembledBouquetService.issue), directly issue PRODUCT lines
   * (FLOWER → FIFO consume, SERVICE → mark issued). Failures become warnings.
   */
  private async issueAll(
    actor: AuthenticatedUser,
    orderId: string,
    context: RequestContext,
  ): Promise<{ issued: number; warnings: string[] }> {
    const warnings: string[] = [];
    let issued = 0;

    const bouquets = await this.prisma.assembledBouquet.findMany({
      where: { orderId, status: AssembledBouquetStatus.ASSEMBLED },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
    for (const b of bouquets) {
      try {
        // Fresh version each time: a previous issue may bump neighbouring rows.
        const fresh = await this.prisma.assembledBouquet.findUniqueOrThrow({
          where: { id: b.id },
          select: { version: true },
        });
        await this.assembled.issue(actor, b.id, fresh.version, context);
        issued++;
      } catch (e) {
        warnings.push(`Букет ${b.number}: ${this.reason(e)}`);
      }
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId, itemType: OrderItemType.PRODUCT },
      orderBy: { sortOrder: 'asc' },
    });
    for (const item of items) {
      const left = item.quantity - item.quantityIssued;
      if (left <= 0) continue;
      try {
        const ord = await this.prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { version: true, status: true },
        });
        if (ord.status === OrderStatus.COMPLETED || ord.status === OrderStatus.CANCELLED) break;
        await this.assembled.directIssueOrderItem(actor, orderId, item.id, left, ord.version, context);
        issued++;
      } catch (e) {
        warnings.push(`${item.nameSnapshot}: ${this.reason(e)}`);
      }
    }

    // Bouquets that were never assembled cannot be handed over.
    const stillOpen = await this.prisma.orderItem.findMany({
      where: { orderId, itemType: OrderItemType.BOUQUET },
      include: { assembledBouquets: { select: { status: true } } },
    });
    for (const item of stillOpen) {
      const done = item.assembledBouquets.filter(
        (a) =>
          a.status === AssembledBouquetStatus.ISSUED ||
          a.status === AssembledBouquetStatus.WRITTEN_OFF,
      ).length;
      if (done < item.quantity && item.quantityIssued < item.quantity) {
        const hasAssembled = item.assembledBouquets.some(
          (a) => a.status === AssembledBouquetStatus.ASSEMBLED,
        );
        if (!hasAssembled) {
          warnings.push(`«${item.nameSnapshot}» не собран — выдача после сборки`);
        }
      }
    }

    return { issued, warnings };
  }

  private reason(e: unknown): string {
    if (e instanceof AppError) return e.message;
    if (e instanceof Error) return e.message;
    return 'не удалось выдать';
  }

  private positiveMoney(raw: string): Prisma.Decimal {
    let v: Prisma.Decimal | null;
    try {
      v = parseMoneyInput(raw);
    } catch {
      throw err('PAYMENT_INVALID_AMOUNT', 'Некорректная сумма');
    }
    if (!v || v.lessThanOrEqualTo(0)) {
      throw err('PAYMENT_INVALID_AMOUNT', 'Сумма платежа должна быть больше нуля');
    }
    return v;
  }

  private assertPermission(actor: AuthenticatedUser, permission: Permission): void {
    if (!roleHasPermission(actor.role as Role, permission)) {
      throw new AppError('FORBIDDEN', 'Недостаточно прав', {}, HttpStatus.FORBIDDEN);
    }
  }
}
