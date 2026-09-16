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
import { BouquetsService } from '../src/modules/bouquets/bouquets.service';
import { hashPassword } from '../src/common/security/password';
import { cancelLeftoverInventories } from './helpers/live-db';

describe('Orders concurrency (live DB)', () => {
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
  const bouquets = new BouquetsService(prisma as never, audit);
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
  let productId = '';
  let bouquetId = '';
  const orderIds: string[] = [];
  const supplyIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Orders Director',
    login: `ord_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-ord',
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
        login: `ord_d_${suffix}`,
        name: 'Orders Director',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorId = d.id;

    const rose = await products.create(
      director(),
      {
        name: `OrdRose ${suffix}`,
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '5.00',
      },
      {},
    );
    productId = rose.id;

    const bq = await bouquets.create(
      director(),
      {
        name: `OrdBq ${suffix}`,
        salePrice: '40.00',
        items: [{ productId, quantity: 3 }],
      },
      {},
    );
    bouquetId = bq.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      const relatedOrders = await prisma.order.findMany({
        where: {
          OR: [
            { id: { in: orderIds } },
            { createdByUserId: directorId || undefined },
            { items: { some: { OR: [{ productId }, { bouquetId }] } } },
          ],
        },
        select: { id: true },
      });
      const ids = [...new Set([...orderIds, ...relatedOrders.map((o) => o.id)])];
      if (ids.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: ids } } });
      }
      if (productId) {
        const movements = await prisma.stockMovement.findMany({
          where: { productId },
          select: { id: true },
        });
        const movementIds = movements.map((m) => m.id);
        if (movementIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: movementIds } },
          });
        }
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { lot: { productId } },
        });
        await prisma.stockLot.deleteMany({ where: { productId } });
        await prisma.stockMovement.deleteMany({ where: { productId } });
      }
      if (ids.length) {
        await prisma.orderItemComponent.deleteMany({
          where: { orderItem: { orderId: { in: ids } } },
        });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ entityId: { in: ids } }, { actorUserId: directorId || undefined }] },
        });
        await prisma.order.deleteMany({ where: { id: { in: ids } } });
      }
      if (supplyIds.length) {
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      if (bouquetId) {
        await prisma.bouquetItem.deleteMany({ where: { bouquetId } });
        await prisma.bouquet.deleteMany({ where: { id: bouquetId } });
      }
      if (productId) {
        await prisma.productStock.deleteMany({ where: { productId } });
        await prisma.product.deleteMany({ where: { id: productId } });
      }
      if (directorId) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: directorId } });
        await prisma.user.delete({ where: { id: directorId } }).catch(() => undefined);
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function ensureStock(qty: number) {
    const open = await prisma.order.findMany({
      where: {
        id: { in: orderIds },
        status: { in: [OrderStatus.NEW, OrderStatus.READY] },
      },
      select: { id: true, version: true },
    });
    for (const o of open) {
      await orders
        .changeStatus(
          director(),
          o.id,
          { status: OrderStatus.CANCELLED, expectedVersion: o.version },
          {},
        )
        .catch(() => undefined);
    }
    const draft = await supplies.create(
      director(),
      {
        documentDate: '2026-09-14',
        items: [{ productId, quantity: qty, unitPurchasePrice: '1.00' }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
  }

  it('allocates unique daily numbers under concurrent creates', async () => {
    if (!ready) return;
    const bt = orders.businessTime();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        orders.create(
          director(),
          {
            customerName: `C${i}`,
            customerPhone: `+3752900000${String(i).padStart(2, '0')}`,
            fulfillmentType: FulfillmentType.PICKUP,
            fulfillmentDate: bt.businessDate,
            items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
          },
          {},
        ),
      ),
    );
    for (const o of results) orderIds.push(o.id);
    const numbers = results.map((r) => r.number);
    expect(new Set(numbers).size).toBe(30);
    expect(numbers.every((n) => n.includes('-'))).toBe(true);
  }, 90_000);

  it('allows only one concurrent update at same expectedVersion', async () => {
    if (!ready) return;
    const bt = orders.businessTime();
    const created = await orders.create(
      director(),
      {
        customerName: 'CAS',
        customerPhone: '+375291111111',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: bt.businessDate,
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
      },
      {},
    );
    orderIds.push(created.id);
    await prisma.order.update({ where: { id: created.id }, data: { version: 5 } });

    const results = await Promise.allSettled([
      orders.update(
        director(),
        created.id,
        {
          expectedVersion: 5,
          customerName: 'Winner A',
          items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 2 }],
        },
        {},
      ),
      orders.update(
        director(),
        created.id,
        {
          expectedVersion: 5,
          customerName: 'Winner B',
          items: [{ itemType: OrderItemType.BOUQUET, bouquetId, quantity: 1 }],
        },
        {},
      ),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'ORDER_CONFLICT' }),
    });
    const final = await orders.getById(director(), created.id);
    expect(final.version).toBe(6);
    expect(final.customerName).toBe(
      (ok[0] as PromiseFulfilledResult<{ customerName: string }>).value.customerName,
    );
  });

  it('snapshots bouquet components and ignores later bouquet edits; COMPLETED consumes FIFO', async () => {
    if (!ready) return;
    await ensureStock(20);
    const stockBefore = await prisma.productStock.findUniqueOrThrow({ where: { productId } });

    const bt = orders.businessTime();
    const created = await orders.create(
      director(),
      {
        customerName: 'Snap',
        customerPhone: '+375292222222',
        fulfillmentType: FulfillmentType.DELIVERY,
        fulfillmentDate: bt.businessDate,
        fulfillmentTimeFrom: '18:00',
        fulfillmentTimeTo: '20:00',
        deliveryAddressText: 'Минск, ул. Примерная 1',
        items: [{ itemType: OrderItemType.BOUQUET, bouquetId, quantity: 2 }],
      },
      {},
    );
    orderIds.push(created.id);
    expect(created.items[0]?.components).toHaveLength(1);
    expect(created.items[0]?.components[0]?.quantityPerItem).toBe(3);
    expect(created.items[0]?.components[0]?.totalQuantity).toBe(6);
    expect(created.hasShortage).toBe(false);

    const bq = await bouquets.getById(director(), bouquetId);
    await bouquets.update(
      director(),
      bouquetId,
      { expectedVersion: bq.version, items: [{ productId, quantity: 9 }] },
      {},
    );
    const again = await orders.getById(director(), created.id);
    expect(again.items[0]?.components[0]?.quantityPerItem).toBe(3);

    const readyOrder = await orders.changeStatus(
      director(),
      created.id,
      { status: OrderStatus.READY, expectedVersion: again.version },
      {},
    );
    await orders.changeStatus(
      director(),
      created.id,
      { status: OrderStatus.COMPLETED, expectedVersion: readyOrder.version },
      {},
    );

    const stockAfter = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stockAfter.quantityOnHand).toBe(stockBefore.quantityOnHand - 6);
    expect(stockAfter.quantityReserved).toBe(0);
    expect(
      await prisma.stockMovement.count({
        where: { productId, type: StockMovementType.SALE, sourceId: created.id },
      }),
    ).toBe(1);
  });

  it('allows only one concurrent status transition at same expectedVersion', async () => {
    if (!ready) return;
    await ensureStock(5);
    const bt = orders.businessTime();
    const created = await orders.create(
      director(),
      {
        customerName: 'StatusCAS',
        customerPhone: '+375293333333',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: bt.businessDate,
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
      },
      {},
    );
    orderIds.push(created.id);
    const readyOrder = await orders.changeStatus(
      director(),
      created.id,
      { status: OrderStatus.READY, expectedVersion: created.version },
      {},
    );

    const results = await Promise.allSettled([
      orders.changeStatus(
        director(),
        created.id,
        { status: OrderStatus.COMPLETED, expectedVersion: readyOrder.version },
        {},
      ),
      orders.changeStatus(
        director(),
        created.id,
        { status: OrderStatus.CANCELLED, expectedVersion: readyOrder.version },
        {},
      ),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'ORDER_CONFLICT' }),
    });
    const final = await orders.getById(director(), created.id);
    expect(final.version).toBe(readyOrder.version + 1);
    expect([OrderStatus.COMPLETED, OrderStatus.CANCELLED]).toContain(final.status);
  });
});
