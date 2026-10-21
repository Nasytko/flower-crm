import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  CashMovementType,
  OrderStatus,
  PaymentKind,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  Permission,
  Role,
  roleHasPermission,
  type OrderPaymentSummaryDto,
  type PaymentDto,
  type PaymentMutationResultDto,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CashShiftService } from '../cash/cash-shift.service';
import { parseMoneyInput } from '../products/product-mapper';
import {
  CancelPaymentDto,
  ConfirmPaymentDto,
  CreatePaymentDto,
  RefundPaymentDto,
} from './dto/payment.dto';
import { paymentInclude, toPaymentDto, type PaymentRow } from './payment-mapper';
import { computeOrderPaymentSummary, computePaymentSummaryDecimals, toMoney } from './payment-calc';

type Tx = Prisma.TransactionClient;

const TX = { maxWait: 10_000, timeout: 30_000 } as const;

export type { PaymentRow };

export interface ChargeInput {
  amount: Prisma.Decimal;
  method: PaymentMethod;
  source: PaymentSource;
  idempotencyKey: string;
  externalProvider?: string | null;
  externalTransactionId?: string | null;
  confirmImmediately: boolean;
  isManual: boolean;
  note?: string | null;
  cashShiftId?: string | null;
  metadata?: Prisma.InputJsonValue;
  /**
   * Internal callers that are already authorized to record a terminal/cash entry
   * (POS quick-sell). Skips the payments.confirm check for manual immediate confirmation.
   */
  trusted?: boolean;
}

export interface ChargeResult {
  payment: PaymentRow;
  replayed: boolean;
  summary: OrderPaymentSummaryDto;
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
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cash: CashShiftService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listForOrder(
    orderId: string,
  ): Promise<{ summary: OrderPaymentSummaryDto; payments: PaymentDto[] }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, total: true },
    });
    if (!order) throw this.orderNotFound();
    const rows = await this.prisma.payment.findMany({
      where: { orderId },
      include: paymentInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      summary: computeOrderPaymentSummary(order.total, rows),
      payments: rows.map((r) => this.toDto(r)),
    };
  }

  // ---------------------------------------------------------------------------
  // Charge
  // ---------------------------------------------------------------------------

  async createCharge(
    actor: AuthenticatedUser,
    orderId: string,
    dto: CreatePaymentDto,
    context: RequestContext = {},
  ): Promise<PaymentMutationResultDto> {
    const amount = this.positiveMoney(dto.amount);
    const source = dto.source ?? PaymentSource.BACKOFFICE;
    const input: ChargeInput = {
      amount,
      method: dto.method,
      source,
      idempotencyKey: dto.idempotencyKey,
      externalProvider: dto.externalProvider ?? null,
      externalTransactionId: dto.externalTransactionId ?? null,
      confirmImmediately: dto.confirmImmediately === true,
      isManual: dto.isManual === true,
      note: dto.note ?? null,
      cashShiftId: dto.cashShiftId ?? null,
    };
    const result = await this.prisma.$transaction(
      (tx) => this.createChargeInTx(tx, actor, orderId, input, context),
      TX,
    );
    return {
      payment: this.toDto(result.payment),
      summary: result.summary,
      replayed: result.replayed,
    };
  }

  /** Core charge flow; callers own the transaction. */
  async createChargeInTx(
    tx: Tx,
    actor: AuthenticatedUser,
    orderId: string,
    input: ChargeInput,
    context: RequestContext = {},
  ): Promise<ChargeResult> {
    const key = input.idempotencyKey.trim();
    if (key.length < 8) {
      throw err(
        'PAYMENT_INVALID_IDEMPOTENCY_KEY',
        'idempotencyKey должен содержать минимум 8 символов',
      );
    }
    if (input.amount.lessThanOrEqualTo(0)) {
      throw err('PAYMENT_INVALID_AMOUNT', 'Сумма платежа должна быть больше нуля');
    }
    if (input.source !== PaymentSource.POS && input.source !== PaymentSource.BACKOFFICE) {
      throw err(
        'PAYMENT_SOURCE_NOT_ALLOWED',
        'Платежи с сайта и интеграций принимаются только через провайдера (ещё не подключён)',
      );
    }
    if (input.externalTransactionId && !input.externalProvider) {
      throw err('PAYMENT_EXTERNAL_PROVIDER_REQUIRED', 'Укажите провайдера внешней операции');
    }

    const order = await this.lockOrder(tx, orderId);
    if (order.status === OrderStatus.CANCELLED) {
      throw err(
        'PAYMENT_ORDER_CANCELLED',
        'Нельзя принять оплату по отменённому заказу',
        {},
        HttpStatus.CONFLICT,
      );
    }

    // Idempotent replay (order row is locked, so concurrent retries serialize here).
    const existing = await tx.payment.findUnique({
      where: { idempotencyKey: key },
      include: paymentInclude,
    });
    if (existing) {
      if (
        existing.orderId !== orderId ||
        existing.kind !== PaymentKind.CHARGE ||
        existing.method !== input.method ||
        !existing.amount.equals(input.amount)
      ) {
        throw err(
          'PAYMENT_IDEMPOTENCY_KEY_REUSED',
          'Ключ идемпотентности уже использован для другого платежа',
          {},
          HttpStatus.CONFLICT,
        );
      }
      return {
        payment: existing,
        replayed: true,
        summary: await this.summaryFor(tx, orderId, order.total),
      };
    }

    // Confirmation rules.
    const isCash = input.method === PaymentMethod.CASH;
    let confirmed = false;
    if (isCash) {
      confirmed = true;
    } else if (input.confirmImmediately) {
      if (!input.isManual) {
        throw err(
          'PAYMENT_MANUAL_REQUIRED',
          'Немедленное подтверждение возможно только как ручная отметка (isManual=true). Автоподтверждение провайдера не подключено.',
        );
      }
      if (!input.trusted && !roleHasPermission(actor.role as Role, Permission.PAYMENTS_CONFIRM)) {
        throw new AppError(
          'FORBIDDEN',
          'Недостаточно прав для подтверждения платежа',
          {},
          HttpStatus.FORBIDDEN,
        );
      }
      confirmed = true;
    }
    if (!isCash && input.cashShiftId) {
      throw err('PAYMENT_CASH_SHIFT_NOT_APPLICABLE', 'Кассовая смена применима только к наличным');
    }

    await this.assertExternalUnique(tx, input.externalProvider, input.externalTransactionId, null);

    const current = await this.summaryDecimals(tx, orderId, order.total);
    if (input.amount.greaterThan(current.remainingDue)) {
      throw err(
        'PAYMENT_EXCEEDS_DUE',
        'Сумма платежа больше остатка к оплате',
        { remainingDue: toMoney(current.remainingDue) },
        HttpStatus.CONFLICT,
      );
    }

    const shift = isCash ? await this.cash.lockOpenShiftForPayment(tx, input.cashShiftId) : null;
    const now = new Date();

    let created: PaymentRow;
    try {
      created = await tx.payment.create({
        data: {
          orderId,
          kind: PaymentKind.CHARGE,
          amount: input.amount,
          method: input.method,
          source: input.source,
          status: confirmed ? PaymentStatus.CONFIRMED : PaymentStatus.PENDING,
          externalProvider: input.externalProvider || null,
          externalTransactionId: input.externalTransactionId || null,
          idempotencyKey: key,
          cashShiftId: shift?.id ?? null,
          isManual: isCash ? false : input.isManual,
          note: input.note?.trim() || null,
          metadata: input.metadata,
          createdByUserId: actor.id,
          confirmedByUserId: confirmed ? actor.id : null,
          confirmedAt: confirmed ? now : null,
        },
        include: paymentInclude,
      });
    } catch (e) {
      throw this.mapUnique(e);
    }

    if (shift) {
      await this.cash.recordPaymentMovement(tx, {
        cashShiftId: shift.id,
        type: CashMovementType.SALE_IN,
        amount: input.amount,
        paymentId: created.id,
        createdByUserId: actor.id,
      });
    }

    const summary = await this.syncOrderPaymentStatus(tx, orderId, order.total);

    await this.audit.log({
      action: AuditAction.PAYMENT_CREATED,
      actorUserId: actor.id,
      entityType: 'Payment',
      entityId: created.id,
      after: this.auditSnapshot(created),
      metadata: { orderId, paymentStatus: summary.paymentStatus },
      context,
      tx,
    });
    if (confirmed) {
      await this.audit.log({
        action: AuditAction.PAYMENT_CONFIRMED,
        actorUserId: actor.id,
        entityType: 'Payment',
        entityId: created.id,
        metadata: { orderId, manual: !isCash, method: input.method },
        context,
        tx,
      });
    }

    return { payment: created, replayed: false, summary };
  }

  // ---------------------------------------------------------------------------
  // Confirm / cancel
  // ---------------------------------------------------------------------------

  async confirm(
    actor: AuthenticatedUser,
    paymentId: string,
    dto: ConfirmPaymentDto,
    context: RequestContext = {},
  ): Promise<PaymentMutationResultDto> {
    if (dto.isManual !== true) {
      throw err(
        'PAYMENT_MANUAL_REQUIRED',
        'Подтверждение возможно только вручную (isManual=true). Автоподтверждение провайдера не подключено.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const orderId = await this.orderIdOfPayment(tx, paymentId);
      const order = await this.lockOrder(tx, orderId);
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: paymentInclude,
      });

      if (payment.kind === PaymentKind.REFUND && !this.can(actor, Permission.PAYMENTS_REFUND)) {
        throw new AppError(
          'FORBIDDEN',
          'Недостаточно прав для подтверждения возврата',
          {},
          HttpStatus.FORBIDDEN,
        );
      }
      if (payment.status === PaymentStatus.CONFIRMED) {
        return {
          payment: this.toDto(payment),
          summary: await this.summaryFor(tx, orderId, order.total),
          replayed: true,
        };
      }
      if (payment.status !== PaymentStatus.PENDING) {
        throw err(
          'PAYMENT_NOT_PENDING',
          'Подтвердить можно только платёж в ожидании',
          { status: payment.status },
          HttpStatus.CONFLICT,
        );
      }
      if (order.status === OrderStatus.CANCELLED && payment.kind === PaymentKind.CHARGE) {
        throw err(
          'PAYMENT_ORDER_CANCELLED',
          'Нельзя подтвердить оплату по отменённому заказу',
          {},
          HttpStatus.CONFLICT,
        );
      }

      const provider = dto.externalProvider || payment.externalProvider || null;
      const txnId = dto.externalTransactionId || payment.externalTransactionId || null;
      if (txnId && !provider) {
        throw err('PAYMENT_EXTERNAL_PROVIDER_REQUIRED', 'Укажите провайдера внешней операции');
      }
      await this.assertExternalUnique(tx, provider, txnId, payment.id);

      let shiftId: string | null = null;
      if (payment.method === PaymentMethod.CASH) {
        shiftId = (
          await this.cash.lockOpenShiftForPayment(tx, dto.cashShiftId ?? payment.cashShiftId)
        ).id;
      }

      let updated: PaymentRow;
      try {
        updated = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.CONFIRMED,
            isManual: true,
            confirmedByUserId: actor.id,
            confirmedAt: new Date(),
            externalProvider: provider,
            externalTransactionId: txnId,
            cashShiftId: shiftId ?? payment.cashShiftId,
            note: dto.note?.trim() ? dto.note.trim() : payment.note,
          },
          include: paymentInclude,
        });
      } catch (e) {
        throw this.mapUnique(e);
      }

      if (shiftId) {
        await this.cash.recordPaymentMovement(tx, {
          cashShiftId: shiftId,
          type:
            payment.kind === PaymentKind.REFUND
              ? CashMovementType.REFUND_OUT
              : CashMovementType.SALE_IN,
          amount: payment.amount,
          paymentId: payment.id,
          createdByUserId: actor.id,
        });
      }

      const before = await this.summaryDecimals(tx, orderId, order.total);
      const summary = await this.syncOrderPaymentStatus(tx, orderId, order.total);
      await this.audit.log({
        action: AuditAction.PAYMENT_CONFIRMED,
        actorUserId: actor.id,
        entityType: 'Payment',
        entityId: payment.id,
        before: { status: payment.status },
        after: this.auditSnapshot(updated),
        metadata: {
          orderId,
          kind: payment.kind,
          manual: true,
          paymentStatus: summary.paymentStatus,
          overpaid: payment.kind === PaymentKind.CHARGE && before.netPaid.greaterThan(order.total),
        },
        context,
        tx,
      });
      return { payment: this.toDto(updated), summary, replayed: false };
    }, TX);
  }

  async cancel(
    actor: AuthenticatedUser,
    paymentId: string,
    dto: CancelPaymentDto,
    context: RequestContext = {},
  ): Promise<PaymentMutationResultDto> {
    return this.prisma.$transaction(async (tx) => {
      const orderId = await this.orderIdOfPayment(tx, paymentId);
      const order = await this.lockOrder(tx, orderId);
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: paymentInclude,
      });
      if (payment.status === PaymentStatus.CANCELLED) {
        return {
          payment: this.toDto(payment),
          summary: await this.summaryFor(tx, orderId, order.total),
          replayed: true,
        };
      }
      // Confirmed payments are never deleted or cancelled; use a refund instead.
      if (payment.status !== PaymentStatus.PENDING) {
        throw err(
          'PAYMENT_NOT_PENDING',
          'Отменить можно только платёж в ожидании. Для подтверждённого создайте возврат.',
          { status: payment.status },
          HttpStatus.CONFLICT,
        );
      }
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.CANCELLED,
          note: dto.note?.trim() ? dto.note.trim() : payment.note,
        },
        include: paymentInclude,
      });
      const summary = await this.syncOrderPaymentStatus(tx, orderId, order.total);
      await this.audit.log({
        action: AuditAction.PAYMENT_CANCELLED,
        actorUserId: actor.id,
        entityType: 'Payment',
        entityId: payment.id,
        before: { status: payment.status },
        after: this.auditSnapshot(updated),
        metadata: { orderId, kind: payment.kind },
        context,
        tx,
      });
      return { payment: this.toDto(updated), summary, replayed: false };
    }, TX);
  }

  // ---------------------------------------------------------------------------
  // Refund (foundation)
  // ---------------------------------------------------------------------------

  /**
   * CASH charge → CONFIRMED REFUND + REFUND_OUT on an open shift.
   * Any other method → PENDING REFUND only (no provider integration yet, never fake success);
   * staff may confirm it manually after refunding outside the system.
   */
  async refund(
    actor: AuthenticatedUser,
    paymentId: string,
    dto: RefundPaymentDto,
    context: RequestContext = {},
  ): Promise<PaymentMutationResultDto> {
    const key = dto.idempotencyKey.trim();
    if (key.length < 8) {
      throw err(
        'PAYMENT_INVALID_IDEMPOTENCY_KEY',
        'idempotencyKey должен содержать минимум 8 символов',
      );
    }
    const requested = dto.amount ? this.positiveMoney(dto.amount) : null;

    return this.prisma.$transaction(async (tx) => {
      const orderId = await this.orderIdOfPayment(tx, paymentId);
      const order = await this.lockOrder(tx, orderId);
      const parent = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

      const replay = await tx.payment.findUnique({
        where: { idempotencyKey: key },
        include: paymentInclude,
      });
      if (replay) {
        if (replay.parentPaymentId !== paymentId || replay.kind !== PaymentKind.REFUND) {
          throw err(
            'PAYMENT_IDEMPOTENCY_KEY_REUSED',
            'Ключ идемпотентности уже использован для другой операции',
            {},
            HttpStatus.CONFLICT,
          );
        }
        return {
          payment: this.toDto(replay),
          summary: await this.summaryFor(tx, orderId, order.total),
          replayed: true,
        };
      }

      if (parent.kind !== PaymentKind.CHARGE || parent.status !== PaymentStatus.CONFIRMED) {
        throw err(
          'PAYMENT_NOT_REFUNDABLE',
          'Вернуть можно только подтверждённый платёж',
          { kind: parent.kind, status: parent.status },
          HttpStatus.CONFLICT,
        );
      }

      const siblings = await tx.payment.findMany({
        where: {
          parentPaymentId: parent.id,
          kind: PaymentKind.REFUND,
          status: { in: [PaymentStatus.CONFIRMED, PaymentStatus.PENDING] },
        },
        select: { amount: true },
      });
      const alreadyRefunded = siblings.reduce(
        (acc, s) => acc.plus(s.amount),
        new Prisma.Decimal(0),
      );
      const refundable = parent.amount.minus(alreadyRefunded);
      const amount = requested ?? refundable;
      if (amount.lessThanOrEqualTo(0) || amount.greaterThan(refundable)) {
        throw err(
          'PAYMENT_REFUND_EXCEEDS',
          'Сумма возврата превышает доступную к возврату',
          { refundable: toMoney(refundable) },
          HttpStatus.CONFLICT,
        );
      }

      const isCash = parent.method === PaymentMethod.CASH;
      const shift = isCash
        ? await this.cash.lockOpenShiftForPayment(tx, dto.cashShiftId ?? null)
        : null;
      const now = new Date();

      let created: PaymentRow;
      try {
        created = await tx.payment.create({
          data: {
            orderId,
            kind: PaymentKind.REFUND,
            amount,
            method: parent.method,
            source: parent.source,
            status: isCash ? PaymentStatus.CONFIRMED : PaymentStatus.PENDING,
            parentPaymentId: parent.id,
            // Provider refund is not sent anywhere; keep the link for the future integration.
            externalProvider: null,
            externalTransactionId: null,
            idempotencyKey: key,
            cashShiftId: shift?.id ?? null,
            isManual: false,
            note: dto.note?.trim() || null,
            metadata: isCash
              ? undefined
              : {
                  foundation: true,
                  providerRefundSent: false,
                  hint: 'Возврат не отправлен провайдеру; подтвердите вручную после фактического возврата',
                },
            createdByUserId: actor.id,
            confirmedByUserId: isCash ? actor.id : null,
            confirmedAt: isCash ? now : null,
          },
          include: paymentInclude,
        });
      } catch (e) {
        throw this.mapUnique(e);
      }

      if (shift) {
        await this.cash.recordPaymentMovement(tx, {
          cashShiftId: shift.id,
          type: CashMovementType.REFUND_OUT,
          amount,
          paymentId: created.id,
          createdByUserId: actor.id,
        });
      }

      const summary = await this.syncOrderPaymentStatus(tx, orderId, order.total);
      await this.audit.log({
        action: AuditAction.PAYMENT_REFUND_CREATED,
        actorUserId: actor.id,
        entityType: 'Payment',
        entityId: created.id,
        after: this.auditSnapshot(created),
        metadata: {
          orderId,
          parentPaymentId: parent.id,
          confirmed: isCash,
          paymentStatus: summary.paymentStatus,
        },
        context,
        tx,
      });
      return { payment: this.toDto(created), summary, replayed: false };
    }, TX);
  }

  // ---------------------------------------------------------------------------
  // Order status sync
  // ---------------------------------------------------------------------------

  /**
   * Recompute Order.paymentStatus from payments. Never touches Order.status / version.
   * Caller must hold the order row lock.
   */
  async syncOrderPaymentStatus(
    tx: Tx,
    orderId: string,
    orderTotal: Prisma.Decimal,
  ): Promise<OrderPaymentSummaryDto> {
    const rows = await tx.payment.findMany({ where: { orderId } });
    const summary = computeOrderPaymentSummary(orderTotal, rows);
    await tx.order.updateMany({
      where: { id: orderId, NOT: { paymentStatus: summary.paymentStatus } },
      data: { paymentStatus: summary.paymentStatus },
    });
    return summary;
  }

  /** `SELECT … FOR UPDATE` on the order; serializes every payment mutation per order. */
  async lockOrder(
    tx: Tx,
    orderId: string,
  ): Promise<{ id: string; status: OrderStatus; total: Prisma.Decimal }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; total: string }>>`
      SELECT id, status::text AS status, total::text AS total
      FROM orders
      WHERE id = ${orderId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw this.orderNotFound();
    return {
      id: row.id,
      status: row.status as OrderStatus,
      total: new Prisma.Decimal(row.total),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async summaryDecimals(tx: Tx, orderId: string, total: Prisma.Decimal) {
    const rows = await tx.payment.findMany({ where: { orderId } });
    return computePaymentSummaryDecimals(total, rows);
  }

  private async summaryFor(
    tx: Tx,
    orderId: string,
    total: Prisma.Decimal,
  ): Promise<OrderPaymentSummaryDto> {
    const rows = await tx.payment.findMany({ where: { orderId } });
    return computeOrderPaymentSummary(total, rows);
  }

  private async orderIdOfPayment(tx: Tx, paymentId: string): Promise<string> {
    const p = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
    if (!p) {
      throw err('PAYMENT_NOT_FOUND', 'Платёж не найден', {}, HttpStatus.NOT_FOUND);
    }
    return p.orderId;
  }

  private async assertExternalUnique(
    tx: Tx,
    provider: string | null | undefined,
    txnId: string | null | undefined,
    excludePaymentId: string | null,
  ): Promise<void> {
    if (!provider || !txnId) return;
    const dup = await tx.payment.findFirst({
      where: {
        externalProvider: provider,
        externalTransactionId: txnId,
        ...(excludePaymentId ? { NOT: { id: excludePaymentId } } : {}),
      },
      select: { id: true, orderId: true },
    });
    if (dup) {
      throw err(
        'PAYMENT_EXTERNAL_DUPLICATE',
        'Операция провайдера уже зарегистрирована',
        { paymentId: dup.id },
        HttpStatus.CONFLICT,
      );
    }
  }

  private mapUnique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = JSON.stringify(e.meta?.target ?? '');
      if (target.includes('idempotencyKey')) {
        return err(
          'PAYMENT_IDEMPOTENCY_KEY_REUSED',
          'Ключ идемпотентности уже использован',
          {},
          HttpStatus.CONFLICT,
        );
      }
      return err(
        'PAYMENT_EXTERNAL_DUPLICATE',
        'Операция провайдера уже зарегистрирована',
        {},
        HttpStatus.CONFLICT,
      );
    }
    return e;
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

  private can(actor: AuthenticatedUser, permission: Permission): boolean {
    return roleHasPermission(actor.role as Role, permission);
  }

  private orderNotFound(): AppError {
    return err('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
  }

  private auditSnapshot(p: PaymentRow) {
    return {
      id: p.id,
      orderId: p.orderId,
      kind: p.kind,
      amount: p.amount.toFixed(2),
      method: p.method,
      status: p.status,
      source: p.source,
      isManual: p.isManual,
      parentPaymentId: p.parentPaymentId,
      cashShiftId: p.cashShiftId,
      externalProvider: p.externalProvider,
      externalTransactionId: p.externalTransactionId,
    };
  }

  toDto(row: PaymentRow): PaymentDto {
    return toPaymentDto(row);
  }
}
