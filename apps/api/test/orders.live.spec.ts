import {
  Role,
  ProductType,
  Unit,
  OrderItemType,
  FulfillmentType,
  OrderStatus,
  DiscountType,
  Permission,
  roleHasPermission,
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
import { cancelLeftoverInventories, createTestSupplier, deleteTestSuppliers } from './helpers/live-db';
import { AppError } from '../src/common/errors/app-error';

describe('Phase 7 orders domain (live DB)', () => {
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
  let floristId = '';
  let managerId = '';
  let supplierId = '';
  let ready = false;
  let productId = '';
  let inactiveProductId = '';
  let bouquetId = '';
  const orderIds: string[] = [];
  const supplyIds: string[] = [];

  const asUser = (id: string, role: Role, login: string) => ({
    id,
    name: login,
    login,
    role,
    sessionId: `live-ord-dom-${role}`,
    isActive: true,
  });

  const director = () => asUser(directorId, Role.DIRECTOR, `ord_dom_d_${suffix}`);
  const florist = () => asUser(floristId, Role.FLORIST, `ord_dom_f_${suffix}`);
  const manager = () => asUser(managerId, Role.MANAGER, `ord_dom_m_${suffix}`);

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return;
    }
    await cancelLeftoverInventories(prisma);
    const passwordHash = await hashPassword('LiveTest123!');
    const [d, f, m] = await Promise.all([
      prisma.user.create({
        data: {
          login: `ord_dom_d_${suffix}`,
          name: 'Ord Dom Dir',
          role: Role.DIRECTOR,
          passwordHash,
        },
      }),
      prisma.user.create({
        data: {
          login: `ord_dom_f_${suffix}`,
          name: 'Ord Dom Flor',
          role: Role.FLORIST,
          passwordHash,
        },
      }),
      prisma.user.create({
        data: {
          login: `ord_dom_m_${suffix}`,
          name: 'Ord Dom Mgr',
          role: Role.MANAGER,
          passwordHash,
        },
      }),
    ]);
    directorId = d.id;
    floristId = f.id;
    managerId = m.id;
    const supplier = await createTestSupplier(prisma, `Orders Live ${suffix}`);
    supplierId = supplier.id;

    const rose = await products.create(
      director(),
      { name: `DomRose ${suffix}`, type: ProductType.FLOWER, unit: Unit.PIECE, salePrice: '10.00' },
      {},
    );
    productId = rose.id;

    const inactive = await products.create(
      director(),
      {
        name: `DomInactive ${suffix}`,
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
        salePrice: '2.00',
      },
      {},
    );
    inactiveProductId = inactive.id;
    await products.update(director(), inactiveProductId, { isActive: false }, {});

    const bq = await bouquets.create(
      director(),
      {
        name: `DomBq ${suffix}`,
        salePrice: '50.00',
        items: [{ productId, quantity: 5 }],
      },
      {},
    );
    bouquetId = bq.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      if (orderIds.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
      }
      for (const id of [productId, inactiveProductId].filter(Boolean)) {
        const movements = await prisma.stockMovement.findMany({
          where: { productId: id },
          select: { id: true },
        });
        const movementIds = movements.map((m) => m.id);
        if (movementIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: movementIds } },
          });
        }
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { lot: { productId: id } },
        });
        await prisma.stockLot.deleteMany({ where: { productId: id } });
        await prisma.stockMovement.deleteMany({ where: { productId: id } });
      }
      if (orderIds.length) {
        await prisma.orderItemComponent.deleteMany({
          where: { orderItem: { orderId: { in: orderIds } } },
        });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.auditLog.deleteMany({ where: { entityId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      if (supplyIds.length) {
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      if (supplierId) {
        await deleteTestSuppliers(prisma, [supplierId]);
      }
      if (bouquetId) {
        await prisma.bouquetItem.deleteMany({ where: { bouquetId } });
        await prisma.bouquet.deleteMany({ where: { id: bouquetId } });
      }
      for (const id of [productId, inactiveProductId].filter(Boolean)) {
        await prisma.productStock.deleteMany({ where: { productId: id } });
        await prisma.product.deleteMany({ where: { id } });
      }
      for (const id of [directorId, floristId, managerId].filter(Boolean)) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: id } });
        await prisma.user.delete({ where: { id } }).catch(() => undefined);
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
        supplierId,
        items: [{ productId, quantity: qty, unitPurchasePrice: '1.00' }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
  }

  function track(id: string) {
    orderIds.push(id);
    return id;
  }

  async function expectReject(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toMatchObject({ code } satisfies Partial<AppError>);
  }

  it('creates PICKUP and DELIVERY; validates address/time/empty/inactive', async () => {
    if (!ready) return;
    const bt = orders.businessTime();
    const day = bt.businessDate;

    const pickup = await orders.create(
      florist(),
      {
        customerName: 'Павел',
        customerPhone: '+375291111111',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: day,
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 2 }],
      },
      {},
    );
    track(pickup.id);
    expect(pickup.status).toBe(OrderStatus.NEW);
    expect(pickup.fulfillmentTimeFrom).toBeNull();
    expect(pickup.subtotal).toBe('20.00');
    expect(pickup.total).toBe('20.00');
    expect(pickup.items[0]?.nameSnapshot).toContain('DomRose');
    expect(pickup.number).toMatch(/^\d{6}-\d{3}$/);

    const delivery = await orders.create(
      florist(),
      {
        customerName: 'Павел',
        customerPhone: '+375291111111',
        fulfillmentType: FulfillmentType.DELIVERY,
        fulfillmentDate: day,
        fulfillmentTimeFrom: '18:00',
        fulfillmentTimeTo: '20:00',
        recipientName: 'Анна',
        recipientPhone: '+375292222222',
        deliveryAddressText: 'Минск, ул. Тестовая 1',
        items: [{ itemType: OrderItemType.BOUQUET, bouquetId, quantity: 1 }],
      },
      {},
    );
    track(delivery.id);
    expect(delivery.effectiveRecipientName).toBe('Анна');
    expect(delivery.items[0]?.components[0]?.quantityPerItem).toBe(5);
    expect(delivery.items[0]?.components[0]?.totalQuantity).toBe(5);

    await expectReject(
      orders.create(
        florist(),
        {
          customerName: 'X',
          customerPhone: '+375290000000',
          fulfillmentType: FulfillmentType.DELIVERY,
          fulfillmentDate: day,
          items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
        },
        {},
      ),
      'ORDER_INVALID_FULFILLMENT',
    );

    await expectReject(
      orders.create(
        florist(),
        {
          customerName: 'X',
          customerPhone: '+375290000000',
          fulfillmentType: FulfillmentType.PICKUP,
          fulfillmentDate: day,
          fulfillmentTimeFrom: '10:00',
          fulfillmentTimeTo: '09:00',
          items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
        },
        {},
      ),
      'ORDER_INVALID_TIME',
    );

    await expectReject(
      orders.create(
        florist(),
        {
          customerName: 'X',
          customerPhone: '+375290000000',
          fulfillmentType: FulfillmentType.PICKUP,
          fulfillmentDate: day,
          items: [],
        },
        {},
      ),
      'ORDER_EMPTY',
    );

    await expectReject(
      orders.create(
        florist(),
        {
          customerName: 'X',
          customerPhone: '+375290000000',
          fulfillmentType: FulfillmentType.PICKUP,
          fulfillmentDate: day,
          items: [{ itemType: OrderItemType.PRODUCT, productId: inactiveProductId, quantity: 1 }],
        },
        {},
      ),
      'ORDER_INACTIVE_PRODUCT',
    );
  });

  it('snapshots product/bouquet; later catalog changes do not alter order', async () => {
    if (!ready) return;
    const bt = orders.businessTime();
    const created = await orders.create(
      director(),
      {
        customerName: 'Snap',
        customerPhone: '+375293333333',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: bt.businessDate,
        items: [
          { itemType: OrderItemType.PRODUCT, productId, quantity: 1 },
          { itemType: OrderItemType.BOUQUET, bouquetId, quantity: 2 },
        ],
      },
      {},
    );
    track(created.id);
    expect(
      created.items.find((i) => i.itemType === OrderItemType.BOUQUET)?.components[0]?.totalQuantity,
    ).toBe(10);

    await products.update(director(), productId, { name: `Renamed ${suffix}` }, {});
    await bouquets.update(
      director(),
      bouquetId,
      {
        expectedVersion: (await bouquets.getById(director(), bouquetId)).version,
        items: [{ productId, quantity: 99 }],
      },
      {},
    );

    const again = await orders.getById(director(), created.id);
    const productLine = again.items.find((i) => i.itemType === OrderItemType.PRODUCT)!;
    const bouquetLine = again.items.find((i) => i.itemType === OrderItemType.BOUQUET)!;
    expect(productLine.nameSnapshot).toContain('DomRose');
    expect(productLine.unitPrice).toBe('10.00');
    expect(bouquetLine.components[0]?.quantityPerItem).toBe(5);
    expect(bouquetLine.unitPrice).toBe('50.00');
  });

  it('rejects forged totals and invalid discounts; florist cannot discount', async () => {
    if (!ready) return;
    const bt = orders.businessTime();
    const day = bt.businessDate;

    await expectReject(
      orders.create(
        florist(),
        {
          customerName: 'F',
          customerPhone: '+375294444444',
          fulfillmentType: FulfillmentType.PICKUP,
          fulfillmentDate: day,
          discountType: DiscountType.PERCENT,
          discountValue: '10',
          items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
        },
        {},
      ),
      'FORBIDDEN',
    );

    const withPct = await orders.create(
      manager(),
      {
        customerName: 'M',
        customerPhone: '+375295555555',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: day,
        discountType: DiscountType.PERCENT,
        discountValue: '10',
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
      },
      {},
    );
    track(withPct.id);
    expect(withPct.subtotal).toBe('10.00');
    expect(withPct.discountAmount).toBe('1.00');
    expect(withPct.total).toBe('9.00');

    const withFixed = await orders.create(
      manager(),
      {
        customerName: 'M2',
        customerPhone: '+375296666666',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: day,
        discountType: DiscountType.FIXED,
        discountValue: '3',
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1, unitPrice: '10.00' }],
      },
      {},
    );
    track(withFixed.id);
    expect(withFixed.total).toBe('7.00');

    await expectReject(
      orders.create(
        manager(),
        {
          customerName: 'M3',
          customerPhone: '+375297777777',
          fulfillmentType: FulfillmentType.PICKUP,
          fulfillmentDate: day,
          discountType: DiscountType.FIXED,
          discountValue: '999',
          items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
        },
        {},
      ),
      'ORDER_INVALID_DISCOUNT',
    );

    expect(roleHasPermission(Role.FLORIST, Permission.ORDERS_DISCOUNT)).toBe(false);
    expect(roleHasPermission(Role.MANAGER, Permission.ORDERS_CANCEL)).toBe(true);
  });

  it('enforces status machine; concurrent status has one winner; COMPLETED consumes stock', async () => {
    if (!ready) return;
    await ensureStock(5);
    const bt = orders.businessTime();
    const stockBefore = await prisma.productStock.findUniqueOrThrow({ where: { productId } });

    const created = await orders.create(
      florist(),
      {
        customerName: 'St',
        customerPhone: '+375298888888',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: bt.businessDate,
        fulfillmentTimeFrom: '09:30',
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
      },
      {},
    );
    track(created.id);
    expect(created.hasShortage).toBe(false);

    const readyOrder = await orders.changeStatus(
      florist(),
      created.id,
      { status: OrderStatus.READY, expectedVersion: created.version },
      {},
    );
    expect(readyOrder.status).toBe(OrderStatus.READY);

    const back = await orders.changeStatus(
      florist(),
      created.id,
      { status: OrderStatus.NEW, expectedVersion: readyOrder.version },
      {},
    );
    expect(back.status).toBe(OrderStatus.NEW);

    const ready2 = await orders.changeStatus(
      florist(),
      created.id,
      { status: OrderStatus.READY, expectedVersion: back.version },
      {},
    );

    const race = await Promise.allSettled([
      orders.changeStatus(
        manager(),
        created.id,
        { status: OrderStatus.COMPLETED, expectedVersion: ready2.version },
        {},
      ),
      orders.changeStatus(
        manager(),
        created.id,
        { status: OrderStatus.CANCELLED, expectedVersion: ready2.version },
        {},
      ),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'ORDER_CONFLICT' }),
    });

    const terminal = await orders.getById(director(), created.id);
    expect([OrderStatus.COMPLETED, OrderStatus.CANCELLED]).toContain(terminal.status);
    await expectReject(
      orders.changeStatus(
        director(),
        created.id,
        { status: OrderStatus.NEW, expectedVersion: terminal.version },
        {},
      ),
      'ORDER_INVALID_STATUS_TRANSITION',
    );

    const stockAfter = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    if (terminal.status === OrderStatus.COMPLETED) {
      expect(stockAfter.quantityOnHand).toBe(stockBefore.quantityOnHand - 1);
      expect(stockAfter.quantityReserved).toBe(0);
      expect(
        await prisma.stockMovement.count({
          where: { productId, type: StockMovementType.SALE, sourceId: created.id },
        }),
      ).toBe(1);
    } else {
      expect(stockAfter.quantityOnHand).toBe(stockBefore.quantityOnHand);
      expect(stockAfter.quantityReserved).toBe(0);
    }
  });

  it('lists by fulfillmentDate with time-first / no-time-last sort', async () => {
    if (!ready) return;
    const day = '2099-03-08';
    const specs: Array<{ timeFrom: string | null; name: string }> = [
      { timeFrom: null, name: 'NoTimeA' },
      { timeFrom: '15:00', name: 'T1500' },
      { timeFrom: '09:30', name: 'T0930' },
      { timeFrom: null, name: 'NoTimeB' },
      { timeFrom: '18:00', name: 'T1800' },
    ];
    for (const s of specs) {
      const o = await orders.create(
        director(),
        {
          customerName: s.name,
          customerPhone: '+375299999999',
          fulfillmentType: FulfillmentType.PICKUP,
          fulfillmentDate: day,
          fulfillmentTimeFrom: s.timeFrom,
          items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
        },
        {},
      );
      track(o.id);
    }

    const listed = await orders.list(director(), { date: day, page: 1, limit: 50 });
    const names = listed.items.map((i) => i.customerName);
    expect(names.slice(0, 3)).toEqual(['T0930', 'T1500', 'T1800']);
    expect(names.slice(3)).toEqual(expect.arrayContaining(['NoTimeA', 'NoTimeB']));
    expect(names.indexOf('NoTimeA')).toBeGreaterThan(names.indexOf('T1800'));

    const deliveryOnly = await orders.list(director(), {
      date: day,
      fulfillmentType: FulfillmentType.DELIVERY,
      page: 1,
      limit: 50,
    });
    expect(deliveryOnly.items).toHaveLength(0);

    const noTime = await orders.list(director(), {
      date: day,
      withoutTime: true,
      page: 1,
      limit: 50,
    });
    expect(noTime.items.every((i) => i.fulfillmentTimeFrom == null)).toBe(true);
  });

  it('clears delivery fields when switching to PICKUP', async () => {
    if (!ready) return;
    const bt = orders.businessTime();
    const created = await orders.create(
      director(),
      {
        customerName: 'Switch',
        customerPhone: '+375290101010',
        fulfillmentType: FulfillmentType.DELIVERY,
        fulfillmentDate: bt.businessDate,
        deliveryAddressText: 'Адрес доставки',
        recipientName: 'R',
        recipientPhone: '+375290202020',
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 1 }],
      },
      {},
    );
    track(created.id);

    const updated = await orders.update(
      director(),
      created.id,
      {
        expectedVersion: created.version,
        fulfillmentType: FulfillmentType.PICKUP,
        deliveryAddressText: null,
        recipientName: null,
        recipientPhone: null,
      },
      {},
    );
    expect(updated.fulfillmentType).toBe(FulfillmentType.PICKUP);
    expect(updated.deliveryAddressText).toBeNull();
    expect(updated.recipientName).toBeNull();
  });
});
