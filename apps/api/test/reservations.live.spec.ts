import {
  Role,
  ProductType,
  Unit,
  OrderItemType,
  FulfillmentType,
  OrderStatus,
  StockMovementType,
} from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { OrdersService } from '../src/modules/orders/orders.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AppConfigService } from '../src/config/app-config.service';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { hashPassword } from '../src/common/security/password';
import { cancelLeftoverInventories } from './helpers/live-db';
import { AppError } from '../src/common/errors/app-error';

describe('Phase 8 reservations (live DB)', () => {
  jest.setTimeout(90_000);
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
  const reservationAllocation = new ReservationAllocationService(audit);
  const products = new ProductsService(prisma as never, audit, warehouseLock, stockFifo);
  const supplies = new SuppliesService(
    prisma as never,
    audit,
    warehouseLock,
    reservationAllocation,
  );
  const orders = new OrdersService(
    prisma as never,
    audit,
    config,
    warehouseLock,
    reservationAllocation,
    stockFifo,
  );
  const suffix = Date.now().toString(36);

  let directorId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];
  const orderIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Res Director',
    login: `res_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-res',
    isActive: true,
  });

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return;
    }
    await cancelLeftoverInventories(prisma);
    const passwordHash = await hashPassword('LiveTest123!');
    const d = await prisma.user.create({
      data: {
        login: `res_d_${suffix}`,
        name: 'Res Director',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorId = d.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      const orderOr: Array<Record<string, unknown>> = [];
      if (orderIds.length) orderOr.push({ id: { in: orderIds } });
      if (directorId) orderOr.push({ createdByUserId: directorId });
      if (productIds.length) {
        orderOr.push({ items: { some: { productId: { in: productIds } } } });
      }

      const relatedOrders = orderOr.length
        ? await prisma.order.findMany({
            where: { OR: orderOr },
            select: { id: true },
          })
        : [];
      const ids = [...new Set([...orderIds, ...relatedOrders.map((o) => o.id)])];

      if (ids.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: ids } } });
      }

      const movementOr: Array<Record<string, unknown>> = [];
      if (productIds.length) movementOr.push({ productId: { in: productIds } });
      const sourceIds = [...ids, ...supplyIds];
      if (sourceIds.length) movementOr.push({ sourceId: { in: sourceIds } });
      const movements = movementOr.length
        ? await prisma.stockMovement.findMany({
            where: { OR: movementOr },
            select: { id: true },
          })
        : [];
      const movementIds = movements.map((m) => m.id);
      if (movementIds.length) {
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { stockMovementId: { in: movementIds } },
        });
      }

      const lots = productIds.length
        ? await prisma.stockLot.findMany({
            where: { productId: { in: productIds } },
            select: { id: true },
          })
        : [];
      const lotIds = lots.map((l) => l.id);
      if (lotIds.length) {
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { stockLotId: { in: lotIds } },
        });
        await prisma.stockLot.deleteMany({ where: { id: { in: lotIds } } });
      }

      if (movementIds.length || productIds.length) {
        await prisma.stockMovement.deleteMany({
          where: {
            OR: [
              ...(movementIds.length ? [{ id: { in: movementIds } }] : []),
              ...(productIds.length ? [{ productId: { in: productIds } }] : []),
            ],
          },
        });
      }

      if (ids.length) {
        await prisma.orderItemComponent.deleteMany({
          where: { orderItem: { orderId: { in: ids } } },
        });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ entityId: { in: ids } }, ...(directorId ? [{ actorUserId: directorId }] : [])],
          },
        });
        await prisma.order.deleteMany({ where: { id: { in: ids } } });
      }

      if (supplyIds.length) {
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }

      if (productIds.length) {
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }

      if (directorId) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: directorId } });
        await prisma.user.delete({ where: { id: directorId } }).catch(() => undefined);
      }
    } catch (error) {
      console.warn('reservations.live afterAll cleanup failed', error);
    } finally {
      await prisma.$disconnect();
    }
  });

  async function flower(name: string): Promise<string> {
    const created = await products.create(
      director(),
      {
        name,
        sku: `P8-${suffix}-${name}`.slice(0, 60),
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '20.00',
      },
      {},
    );
    productIds.push(created.id);
    return created.id;
  }

  async function postSupply(
    productId: string,
    quantity: number,
    unitPurchasePrice: string,
    documentDate = '2026-09-15',
  ): Promise<string> {
    const draft = await supplies.create(
      director(),
      {
        documentDate,
        items: [{ productId, quantity, unitPurchasePrice }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
    return draft.id;
  }

  function trackOrder(id: string) {
    orderIds.push(id);
    return id;
  }

  async function createProductOrder(input: {
    productId: string;
    quantity: number;
    fulfillmentDate: string;
    fulfillmentTimeFrom?: string | null;
    customerName: string;
  }) {
    const created = await orders.create(
      director(),
      {
        customerName: input.customerName,
        customerPhone: '+375291000000',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: input.fulfillmentDate,
        fulfillmentTimeFrom: input.fulfillmentTimeFrom ?? undefined,
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId: input.productId,
            quantity: input.quantity,
          },
        ],
      },
      {},
    );
    trackOrder(created.id);
    return created;
  }

  it('A: concurrent creates never over-reserve (onHand=10, two×8 → reserved=10)', async () => {
    if (!ready) return;
    const productId = await flower(`A ${suffix}`);
    await postSupply(productId, 10, '5.00');

    const day = orders.businessTime().businessDate;
    const results = await Promise.allSettled([
      createProductOrder({
        productId,
        quantity: 8,
        fulfillmentDate: day,
        fulfillmentTimeFrom: '10:00',
        customerName: 'A1',
      }),
      createProductOrder({
        productId,
        quantity: 8,
        fulfillmentDate: day,
        fulfillmentTimeFrom: '11:00',
        customerName: 'A2',
      }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(10);
    expect(stock.quantityReserved).toBe(10);
    expect(stock.quantityReserved).not.toBe(16);

    const reservations = await prisma.stockReservation.findMany({ where: { productId } });
    const sum = reservations.reduce((s, r) => s + r.reservedQuantity, 0);
    expect(sum).toBe(10);
    expect(reservations.every((r) => r.requiredQuantity === 8)).toBe(true);
    expect(reservations.reduce((s, r) => s + r.reservedQuantity, 0)).toBe(10);
  }, 90_000);

  it('B: supply allocates by priority (A+5 B+7 C+0)', async () => {
    if (!ready) return;
    const productId = await flower(`B ${suffix}`);
    const today = orders.businessTime().businessDate;
    const parts = today.split('-').map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 9;
    const d = parts[2] ?? 15;
    const tomorrowDate = new Date(Date.UTC(y, m - 1, d + 1));
    const tomorrow = tomorrowDate.toISOString().slice(0, 10);

    const a = await createProductOrder({
      productId,
      quantity: 5,
      fulfillmentDate: today,
      fulfillmentTimeFrom: '14:00',
      customerName: 'PriA',
    });
    const b = await createProductOrder({
      productId,
      quantity: 10,
      fulfillmentDate: today,
      fulfillmentTimeFrom: '18:00',
      customerName: 'PriB',
    });
    const c = await createProductOrder({
      productId,
      quantity: 10,
      fulfillmentDate: tomorrow,
      fulfillmentTimeFrom: '10:00',
      customerName: 'PriC',
    });

    expect((await orders.getById(director(), a.id)).hasShortage).toBe(true);
    await postSupply(productId, 12, '4.00');

    const ra = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: a.id, productId } },
    });
    const rb = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: b.id, productId } },
    });
    const rc = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: c.id, productId } },
    });
    expect(ra.reservedQuantity).toBe(5);
    expect(rb.reservedQuantity).toBe(7);
    expect(rc.reservedQuantity).toBe(0);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityReserved).toBe(12);
  });

  it('C: cancel reallocates released stock to shortage order', async () => {
    if (!ready) return;
    const productId = await flower(`C ${suffix}`);
    await postSupply(productId, 10, '3.00');
    const day = orders.businessTime().businessDate;

    const a = await createProductOrder({
      productId,
      quantity: 10,
      fulfillmentDate: day,
      fulfillmentTimeFrom: '09:00',
      customerName: 'CancelA',
    });
    const b = await createProductOrder({
      productId,
      quantity: 6,
      fulfillmentDate: day,
      fulfillmentTimeFrom: '10:00',
      customerName: 'CancelB',
    });

    expect(
      (
        await prisma.stockReservation.findUniqueOrThrow({
          where: { orderId_productId: { orderId: a.id, productId } },
        })
      ).reservedQuantity,
    ).toBe(10);
    expect(
      (
        await prisma.stockReservation.findUniqueOrThrow({
          where: { orderId_productId: { orderId: b.id, productId } },
        })
      ).reservedQuantity,
    ).toBe(0);

    await orders.changeStatus(
      director(),
      a.id,
      { status: OrderStatus.CANCELLED, expectedVersion: a.version },
      {},
    );

    const rb = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: b.id, productId } },
    });
    expect(rb.reservedQuantity).toBe(6);
    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(10);
    expect(stock.quantityReserved).toBe(6);
    expect(stock.quantityOnHand - stock.quantityReserved).toBe(4);
  });

  it('D: completion FIFO COGS 86 and SALE movements', async () => {
    if (!ready) return;
    const productId = await flower(`D ${suffix}`);
    await postSupply(productId, 5, '10.00', '2026-09-01');
    await new Promise((r) => setTimeout(r, 50));
    await postSupply(productId, 10, '12.00', '2026-09-02');

    const day = orders.businessTime().businessDate;
    const created = await createProductOrder({
      productId,
      quantity: 8,
      fulfillmentDate: day,
      fulfillmentTimeFrom: '12:00',
      customerName: 'FifoD',
    });
    expect(created.hasShortage).toBe(false);

    const readyOrder = await orders.changeStatus(
      director(),
      created.id,
      { status: OrderStatus.READY, expectedVersion: created.version },
      {},
    );
    const completed = await orders.changeStatus(
      director(),
      readyOrder.id,
      { status: OrderStatus.COMPLETED, expectedVersion: readyOrder.version },
      {},
    );
    expect(completed.actualCost).toBe('86.00');
    expect(completed.hasUncostedConsumption).toBe(false);
    expect(completed.hasShortage).toBe(false);

    const lots = await prisma.stockLot.findMany({
      where: { productId },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });
    expect(lots[0]?.remainingQuantity).toBe(0);
    expect(lots[1]?.remainingQuantity).toBe(7);

    const sales = await prisma.stockMovement.findMany({
      where: { productId, type: StockMovementType.SALE, sourceId: created.id },
      include: { allocations: true },
    });
    expect(sales).toHaveLength(1);
    expect(sales[0]?.quantity).toBe(-8);
    const allocQty = sales[0]!.allocations.reduce((s, a) => s + a.quantity, 0);
    expect(allocQty).toBe(8);
    const byLot = new Map(sales[0]!.allocations.map((a) => [a.stockLotId, a.quantity]));
    expect(byLot.get(lots[0]!.id)).toBe(5);
    expect(byLot.get(lots[1]!.id)).toBe(3);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(7);
    expect(stock.quantityReserved).toBe(0);
  });

  it('E: shortage blocks READY and COMPLETED', async () => {
    if (!ready) return;
    const productId = await flower(`E ${suffix}`);
    await postSupply(productId, 2, '1.00');
    const day = orders.businessTime().businessDate;
    const created = await createProductOrder({
      productId,
      quantity: 5,
      fulfillmentDate: day,
      customerName: 'ShortE',
    });
    expect(created.hasShortage).toBe(true);

    await expect(
      orders.changeStatus(
        director(),
        created.id,
        { status: OrderStatus.READY, expectedVersion: created.version },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ORDER_HAS_SHORTAGE' } satisfies Partial<AppError>);

    // Force READY via prisma to assert COMPLETED also blocked (status machine + shortage).
    await prisma.order.update({
      where: { id: created.id },
      data: { status: OrderStatus.READY, version: created.version + 1 },
    });
    const forced = await orders.getById(director(), created.id);
    await expect(
      orders.changeStatus(
        director(),
        created.id,
        { status: OrderStatus.COMPLETED, expectedVersion: forced.version },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ORDER_HAS_SHORTAGE' } satisfies Partial<AppError>);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(2);
    expect(stock.quantityReserved).toBe(2);
  });

  it('F: write-off cannot exceed available (reserved protected)', async () => {
    if (!ready) return;
    const productId = await flower(`F ${suffix}`);
    await postSupply(productId, 10, '2.00');
    const day = orders.businessTime().businessDate;
    await createProductOrder({
      productId,
      quantity: 7,
      fulfillmentDate: day,
      customerName: 'WriteF',
    });

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityReserved).toBe(7);
    expect(stock.quantityOnHand - stock.quantityReserved).toBe(3);

    await expect(
      products.writeOff(director(), productId, { quantity: 4, reason: 'too much' }, {}),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' } satisfies Partial<AppError>);

    const ok = await products.writeOff(
      director(),
      productId,
      { quantity: 3, reason: 'available only' },
      {},
    );
    expect(ok.quantityOnHand).toBe(7);
    const after = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(after.quantityReserved).toBe(7);
    expect(after.quantityOnHand).toBe(7);
  });

  it('G: no preemption — early shortage does not steal late reservation', async () => {
    if (!ready) return;
    const productId = await flower(`G ${suffix}`);
    await postSupply(productId, 10, '2.50');
    const today = orders.businessTime().businessDate;
    const parts = today.split('-').map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 9;
    const d = parts[2] ?? 15;
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

    const late = await createProductOrder({
      productId,
      quantity: 10,
      fulfillmentDate: tomorrow,
      fulfillmentTimeFrom: '18:00',
      customerName: 'LateG',
    });
    expect(
      (
        await prisma.stockReservation.findUniqueOrThrow({
          where: { orderId_productId: { orderId: late.id, productId } },
        })
      ).reservedQuantity,
    ).toBe(10);

    const early = await createProductOrder({
      productId,
      quantity: 8,
      fulfillmentDate: today,
      fulfillmentTimeFrom: '09:00',
      customerName: 'EarlyG',
    });

    const lateRes = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: late.id, productId } },
    });
    const earlyRes = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: early.id, productId } },
    });
    expect(lateRes.reservedQuantity).toBe(10);
    expect(earlyRes.reservedQuantity).toBe(0);
    expect(early.hasShortage).toBe(true);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityReserved).toBe(10);
  });
});
