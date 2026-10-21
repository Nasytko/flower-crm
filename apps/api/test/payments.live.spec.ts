import {
  OrderFulfillmentMode,
  OrderPaymentStatus,
  PaymentKind,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  PosCartLineType,
  ProductType,
  Role,
  Unit,
} from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { AuditService } from '../src/modules/audit/audit.service';
import { AppConfigService } from '../src/config/app-config.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { StockBalanceService } from '../src/modules/warehouse/stock-balance.service';
import { AssembledBouquetService } from '../src/modules/warehouse/assembled-bouquet.service';
import { PosCartService } from '../src/modules/pos/pos-cart.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { CashShiftService } from '../src/modules/cash/cash-shift.service';
import { hashPassword } from '../src/common/security/password';
import { AppError } from '../src/common/errors/app-error';

describe('Payments + cash shifts (live DB)', () => {
  jest.setTimeout(120_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    it.skip('DATABASE_URL is not set', () => undefined);
    return;
  }

  const prisma = createPrismaClient(databaseUrl);
  const audit = new AuditService(prisma as never);
  const config = {
    businessTimeZone: process.env.BUSINESS_TIME_ZONE ?? 'Europe/Minsk',
  } as AppConfigService;
  const warehouseLock = new WarehouseLockService();
  const stockFifo = new StockFifoService();
  const reservationAllocation = new ReservationAllocationService(audit, stockFifo);
  const stockBalance = new StockBalanceService();
  const assembled = new AssembledBouquetService(
    prisma as never,
    warehouseLock,
    stockFifo,
    stockBalance,
    reservationAllocation,
    audit,
    config,
  );
  const cash = new CashShiftService(prisma as never, audit);
  const payments = new PaymentsService(prisma as never, audit, cash);
  const pos = new PosCartService(
    prisma as never,
    audit,
    config,
    warehouseLock,
    reservationAllocation,
    assembled,
  );
  const suffix = Date.now().toString(36);

  let directorId = '';
  let ready = false;
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const cartIds: string[] = [];
  const shiftIds: string[] = [];

  const director = () =>
    ({
      id: directorId,
      role: Role.DIRECTOR,
      sessionId: 's',
      name: 'Dir',
      login: `dir-pay-${suffix}`,
      isActive: true,
    }) as const;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return;
    }
    const user = await prisma.user.create({
      data: {
        name: 'Pay Dir',
        login: `dir-pay-${suffix}`,
        passwordHash: await hashPassword('Password1!'),
        role: Role.DIRECTOR,
      },
    });
    directorId = user.id;
    ready = true;
  });

  afterAll(async () => {
    if (!ready) {
      await prisma.$disconnect();
      return;
    }
    for (const id of orderIds) {
      await prisma.payment.deleteMany({ where: { orderId: id } }).catch(() => undefined);
      await prisma.stockReservation.deleteMany({ where: { orderId: id } }).catch(() => undefined);
      await prisma.orderItemComponent
        .deleteMany({ where: { orderItem: { orderId: id } } })
        .catch(() => undefined);
      await prisma.orderItem.deleteMany({ where: { orderId: id } }).catch(() => undefined);
      await prisma.order.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of cartIds) {
      await prisma.posCartLineComponent
        .deleteMany({ where: { line: { cartId: id } } })
        .catch(() => undefined);
      await prisma.posCartLine.deleteMany({ where: { cartId: id } }).catch(() => undefined);
      await prisma.posCart.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of shiftIds) {
      await prisma.cashMovement.deleteMany({ where: { cashShiftId: id } }).catch(() => undefined);
      await prisma.payment.updateMany({ where: { cashShiftId: id }, data: { cashShiftId: null } });
      await prisma.cashShift.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of productIds) {
      await prisma.productStock.deleteMany({ where: { productId: id } }).catch(() => undefined);
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    if (directorId) await prisma.user.delete({ where: { id: directorId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function serviceProduct(): Promise<string> {
    const p = await prisma.product.create({
      data: {
        name: `PaySvc ${suffix}`,
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
        salePrice: '40.00',
        isActive: true,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  async function confirmServiceOrder(totalHint = '40.00') {
    const productId = await serviceProduct();
    let cart = await pos.createCart(director());
    cartIds.push(cart.id);
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.SERVICE,
      productId,
      expectedVersion: cart.version,
    });
    const confirmed = await pos.confirm(director(), cart.id, {
      expectedVersion: cart.version,
      idempotencyKey: `pay-confirm-${suffix}-${cart.id}`,
      fulfillmentMode: OrderFulfillmentMode.WALK_IN,
    });
    orderIds.push(confirmed.orderId);
    return { orderId: confirmed.orderId, totalHint, cart };
  }

  it('partial + pending: only CONFIRMED charges count toward paid', async () => {
    if (!ready) return;
    const { orderId } = await confirmServiceOrder();

    const shift = await cash.open(director(), { openingFloat: '100.00' });
    shiftIds.push(shift.id);

    await payments.createCharge(
      director(),
      orderId,
      {
        amount: '10.00',
        method: PaymentMethod.CASH,
        source: PaymentSource.POS,
        idempotencyKey: `cash-10-${suffix}`,
      },
      {},
    );

    await payments.createCharge(
      director(),
      orderId,
      {
        amount: '20.00',
        method: PaymentMethod.ERIP,
        source: PaymentSource.BACKOFFICE,
        idempotencyKey: `erip-20-${suffix}`,
        externalProvider: 'erip',
        externalTransactionId: `tx-${suffix}-1`,
      },
      {},
    );

    const listed = await payments.listForOrder(orderId);
    expect(listed.summary.confirmedPaid).toBe('10.00');
    expect(listed.summary.pendingAmount).toBe('20.00');
    expect(listed.summary.netPaid).toBe('10.00');
    expect(listed.summary.remainingDue).toBe('30.00');
    expect(listed.summary.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
    expect(order.status).not.toBe('COMPLETED');
  });

  it('idempotent payment create and unique external transaction', async () => {
    if (!ready) return;
    const { orderId } = await confirmServiceOrder();
    const key = `idem-pay-${suffix}`;
    const a = await payments.createCharge(
      director(),
      orderId,
      {
        amount: '5.00',
        method: PaymentMethod.CARD_TERMINAL,
        source: PaymentSource.POS,
        idempotencyKey: key,
        confirmImmediately: true,
        isManual: true,
      },
      {},
    );
    const b = await payments.createCharge(
      director(),
      orderId,
      {
        amount: '5.00',
        method: PaymentMethod.CARD_TERMINAL,
        source: PaymentSource.POS,
        idempotencyKey: key,
        confirmImmediately: true,
        isManual: true,
      },
      {},
    );
    expect(b.payment.id).toBe(a.payment.id);
    expect(b.replayed).toBe(true);

    await payments.createCharge(
      director(),
      orderId,
      {
        amount: '5.00',
        method: PaymentMethod.ERIP,
        source: PaymentSource.BACKOFFICE,
        idempotencyKey: `ext-${suffix}-a`,
        externalProvider: 'erip',
        externalTransactionId: `dup-${suffix}`,
      },
      {},
    );
    await expect(
      payments.createCharge(
        director(),
        orderId,
        {
          amount: '5.00',
          method: PaymentMethod.ERIP,
          source: PaymentSource.BACKOFFICE,
          idempotencyKey: `ext-${suffix}-b`,
          externalProvider: 'erip',
          externalTransactionId: `dup-${suffix}`,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('cash charge requires open shift; concurrent open conflicts', async () => {
    if (!ready) return;
    // Close any leftover open shift on MAIN from prior tests in this file.
    const open = await cash.getCurrent();
    if (open) {
      await cash.close(director(), open.id, { countedCash: open.openingFloat });
    }

    const { orderId } = await confirmServiceOrder();
    await expect(
      payments.createCharge(
        director(),
        orderId,
        {
          amount: '40.00',
          method: PaymentMethod.CASH,
          source: PaymentSource.POS,
          idempotencyKey: `no-shift-${suffix}`,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/CASH|SHIFT/) });

    const first = await cash.open(director(), { openingFloat: '50.00' });
    shiftIds.push(first.id);
    await expect(cash.open(director(), { openingFloat: '10.00' })).rejects.toBeInstanceOf(AppError);

    const paid = await payments.createCharge(
      director(),
      orderId,
      {
        amount: '40.00',
        method: PaymentMethod.CASH,
        source: PaymentSource.POS,
        idempotencyKey: `with-shift-${suffix}`,
      },
      {},
    );
    expect(paid.payment.status).toBe(PaymentStatus.CONFIRMED);
    expect(paid.summary.paymentStatus).toBe(OrderPaymentStatus.PAID);

    const refundKey = `refund-${suffix}`;
    const refund = await payments.refund(
      director(),
      paid.payment.id,
      { amount: '10.00', idempotencyKey: refundKey, note: 'test' },
      {},
    );
    expect(refund.payment.kind).toBe(PaymentKind.REFUND);
    expect(refund.summary.confirmedRefunded).toBe('10.00');
    expect(refund.summary.netPaid).toBe('30.00');
    expect(refund.summary.remainingDue).toBe('10.00');
    expect(refund.summary.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_REFUNDED);

    const refundReplay = await payments.refund(
      director(),
      paid.payment.id,
      { amount: '10.00', idempotencyKey: refundKey, note: 'retry' },
      {},
    );
    expect(refundReplay.replayed).toBe(true);
    expect(refundReplay.payment.id).toBe(refund.payment.id);
    expect(refundReplay.summary.confirmedRefunded).toBe('10.00');
    expect(await prisma.payment.count({ where: { orderId, kind: PaymentKind.REFUND } })).toBe(1);

    // Concurrent close: only one succeeds.
    const results = await Promise.allSettled([
      cash.close(director(), first.id, { countedCash: '90.00' }),
      cash.close(director(), first.id, { countedCash: '91.00' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(1);
    const closed = await prisma.cashShift.findUniqueOrThrow({ where: { id: first.id } });
    expect(closed.status).toBe('CLOSED');
  });
});
