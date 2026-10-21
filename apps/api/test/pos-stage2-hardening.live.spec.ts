import {
  OrderFulfillmentMode,
  OrderItemType,
  OrderPaymentStatus,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  PosCartLineType,
  PosCartStatus,
  ProductType,
  Role,
  StockLotSource,
  SupplyStatus,
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
import { PosQuickSellService } from '../src/modules/pos/pos-quick-sell.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { CashShiftService } from '../src/modules/cash/cash-shift.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { hashPassword } from '../src/common/security/password';
import { AppError } from '../src/common/errors/app-error';
import { createTestSupplier, deleteTestSuppliers } from './helpers/live-db';

/**
 * Stage 2 hardening: composition lock, quick-sell retry after stock failure.
 * Skipped without DATABASE_URL (CI Postgres).
 */
describe('POS stage2 hardening (live DB)', () => {
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
  const quickSell = new PosQuickSellService(prisma as never, audit, pos, payments, cash, assembled);
  const orders = new OrdersService(
    prisma as never,
    audit,
    config,
    warehouseLock,
    reservationAllocation,
  );
  const suffix = Date.now().toString(36);

  let directorId = '';
  let ready = false;
  let supplierId = '';
  const productIds: string[] = [];
  const cartIds: string[] = [];
  const orderIds: string[] = [];
  const shiftIds: string[] = [];
  const supplyIds: string[] = [];

  const director = () =>
    ({
      id: directorId,
      name: 'S2 Dir',
      login: `s2_d_${suffix}`,
      role: Role.DIRECTOR,
      sessionId: 'live-s2',
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
        name: 'S2 Dir',
        login: `s2_d_${suffix}`,
        passwordHash: await hashPassword('Password1!'),
        role: Role.DIRECTOR,
      },
    });
    directorId = user.id;
    const supplier = await createTestSupplier(prisma, `S2 Sup ${suffix}`);
    supplierId = supplier.id;
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
      await prisma.assembledBouquet
        .updateMany({ where: { orderId: id }, data: { orderId: null, orderItemId: null } })
        .catch(() => undefined);
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
      await prisma.stockMovementLotAllocation
        .deleteMany({ where: { movement: { productId: id } } })
        .catch(() => undefined);
      await prisma.stockMovement.deleteMany({ where: { productId: id } }).catch(() => undefined);
      await prisma.stockLot.deleteMany({ where: { productId: id } }).catch(() => undefined);
      await prisma.supplyItem.deleteMany({ where: { productId: id } }).catch(() => undefined);
      await prisma.productStock.deleteMany({ where: { productId: id } }).catch(() => undefined);
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of supplyIds) {
      await prisma.supply.delete({ where: { id } }).catch(() => undefined);
    }
    await deleteTestSuppliers(prisma, supplierId ? [supplierId] : []);
    if (directorId) await prisma.user.delete({ where: { id: directorId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function serviceProduct(price = '25.00') {
    const p = await prisma.product.create({
      data: {
        name: `S2Svc ${suffix} ${price}`,
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
        salePrice: price,
        isActive: true,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  async function flowerNoStock(name: string) {
    const p = await prisma.product.create({
      data: {
        name: `${name} ${suffix}`,
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '10.00',
        isActive: true,
        stock: { create: { quantityOnHand: 0, quantityReserved: 0, quantityInBouquets: 0 } },
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  async function ensureShift() {
    const open = await cash.getCurrent();
    if (open) return open;
    const s = await cash.open(director(), { openingFloat: '200.00' });
    shiftIds.push(s.id);
    return s;
  }

  it('ORDER_COMPOSITION_LOCKED: header-only OK; composition replace rejected; lines intact', async () => {
    if (!ready) return;
    const productId = await serviceProduct('30.00');
    let cart = await pos.createCart(director());
    cartIds.push(cart.id);
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.SERVICE,
      productId,
      expectedVersion: cart.version,
    });
    const confirmed = await pos.confirm(director(), cart.id, {
      expectedVersion: cart.version,
      idempotencyKey: `comp-lock-${suffix}`,
      fulfillmentMode: OrderFulfillmentMode.WALK_IN,
    });
    orderIds.push(confirmed.orderId);

    const before = await prisma.order.findUniqueOrThrow({
      where: { id: confirmed.orderId },
      include: { items: { include: { components: true } } },
    });
    expect(before.source).toBe(OrderSource.POS);
    expect(before.items).toHaveLength(1);
    const itemId = before.items[0]!.id;
    const itemName = before.items[0]!.nameSnapshot;
    const itemPrice = before.items[0]!.unitPrice.toFixed(2);

    // Header-only (no items) — must not wipe composition.
    const header = await orders.update(
      director(),
      confirmed.orderId,
      {
        expectedVersion: before.version,
        customerName: 'Walk-in Guest',
        orderComment: 'header only',
      },
      {},
    );
    expect(header.customerName).toBe('Walk-in Guest');
    expect(header.items).toHaveLength(1);
    expect(header.items[0]!.id).toBe(itemId);
    expect(header.items[0]!.nameSnapshot).toBe(itemName);
    expect(header.items[0]!.unitPrice).toBe(itemPrice);

    // Composition replace rejected.
    await expect(
      orders.update(
        director(),
        confirmed.orderId,
        {
          expectedVersion: header.version,
          items: [
            {
              itemType: OrderItemType.PRODUCT,
              productId,
              quantity: 2,
              unitPrice: '99.00',
            },
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ORDER_COMPOSITION_LOCKED' });

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: confirmed.orderId },
      include: { items: true },
    });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.id).toBe(itemId);
    expect(after.items[0]!.unitPrice.toFixed(2)).toBe(itemPrice);
    expect(after.customerName).toBe('Walk-in Guest');
  });

  it('quick-sell: pay CONFIRMED, issue fails, retry continues issue without new order/payment', async () => {
    if (!ready) return;
    await ensureShift();

    const flowerId = await flowerNoStock('QsFlower');
    let cart = await pos.createCart(director());
    cartIds.push(cart.id);
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.PRODUCT,
      productId: flowerId,
      quantity: 1,
      expectedVersion: cart.version,
    });

    const sellKey = `qs-retry-${suffix}`;
    const payKey = `${sellKey}-pay`;
    const first = await quickSell.quickSell(
      director(),
      cart.id,
      {
        expectedVersion: cart.version,
        idempotencyKey: sellKey,
        issue: true,
        payments: [{ method: PaymentMethod.CASH, amount: cart.total, idempotencyKey: payKey }],
      },
      {},
    );
    orderIds.push(first.orderId);
    expect(first.paymentStatus).toBe(OrderPaymentStatus.PAID);
    expect(first.orderStatus).not.toBe(OrderStatus.COMPLETED);
    expect(first.warnings.length).toBeGreaterThan(0);
    expect(first.payments).toHaveLength(1);
    expect(first.payments[0]!.status).toBe(PaymentStatus.CONFIRMED);

    const paymentsAfterFirst = await prisma.payment.count({ where: { orderId: first.orderId } });
    expect(paymentsAfterFirst).toBe(1);
    expect(await prisma.order.count({ where: { id: first.orderId } })).toBe(1);

    // Restock via SUPPLY lot (inventory lots require inventoryItemId).
    const maxNum = await prisma.supply.aggregate({ _max: { number: true } });
    const supply = await prisma.supply.create({
      data: {
        number: (maxNum._max.number ?? 0) + 1,
        status: SupplyStatus.POSTED,
        documentDate: new Date(),
        supplierId,
        supplierName: 'S2 restock',
        createdByUserId: directorId,
        postedByUserId: directorId,
        postedAt: new Date(),
        items: {
          create: {
            productId: flowerId,
            quantity: 5,
            unitPurchasePrice: '3.00',
            lot: {
              create: {
                productId: flowerId,
                sourceType: StockLotSource.SUPPLY,
                receivedQuantity: 5,
                remainingQuantity: 5,
                receivedAt: new Date(),
                unitPurchasePrice: '3.00',
              },
            },
          },
        },
      },
    });
    supplyIds.push(supply.id);
    await prisma.productStock.update({
      where: { productId: flowerId },
      data: { quantityOnHand: 5 },
    });

    const cartAfter = await prisma.posCart.findUniqueOrThrow({ where: { id: cart.id } });
    expect(cartAfter.status).toBe(PosCartStatus.CONFIRMED);

    const second = await quickSell.quickSell(
      director(),
      cart.id,
      {
        expectedVersion: cartAfter.version,
        idempotencyKey: sellKey,
        issue: true,
        payments: [
          { method: PaymentMethod.CASH, amount: first.payments[0]!.amount, idempotencyKey: payKey },
        ],
      },
      {},
    );
    expect(second.orderId).toBe(first.orderId);
    expect(await prisma.payment.count({ where: { orderId: first.orderId } })).toBe(1);
    expect(
      await prisma.order.count({ where: { source: OrderSource.POS, id: first.orderId } }),
    ).toBe(1);
    expect(second.orderStatus).toBe(OrderStatus.COMPLETED);
    expect(second.issued).toBe(true);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId: flowerId } });
    expect(stock.quantityOnHand).toBe(4);
    const moves = await prisma.stockMovement.count({
      where: { productId: flowerId, type: 'DIRECT_ISSUE' },
    });
    expect(moves).toBe(1);
  });

  it('cash payment without open shift is rejected', async () => {
    if (!ready) return;
    const open = await cash.getCurrent();
    if (open) {
      await cash.close(director(), open.id, { countedCash: open.openingFloat ?? '0.00' });
    }

    const productId = await serviceProduct('15.00');
    let cart = await pos.createCart(director());
    cartIds.push(cart.id);
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.SERVICE,
      productId,
      expectedVersion: cart.version,
    });
    const confirmed = await pos.confirm(director(), cart.id, {
      expectedVersion: cart.version,
      idempotencyKey: `no-cash-${suffix}`,
      fulfillmentMode: OrderFulfillmentMode.WALK_IN,
    });
    orderIds.push(confirmed.orderId);

    await expect(
      payments.createCharge(
        director(),
        confirmed.orderId,
        {
          amount: '15.00',
          method: PaymentMethod.CASH,
          source: PaymentSource.POS,
          idempotencyKey: `nocash-pay-${suffix}`,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
