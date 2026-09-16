import {
  Role,
  ProductType,
  Unit,
  OrderItemType,
  FulfillmentType,
  OrderStatus,
  StockMovementType,
  StockLotSource,
  InventoryStatus,
} from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { OrdersService } from '../src/modules/orders/orders.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AppConfigService } from '../src/config/app-config.service';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { InventoriesService } from '../src/modules/inventories/inventories.service';
import { BouquetsService } from '../src/modules/bouquets/bouquets.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { hashPassword } from '../src/common/security/password';
import { cancelLeftoverInventories, createTestSupplier, deleteTestSuppliers } from './helpers/live-db';
import { AppError } from '../src/common/errors/app-error';

describe('Phase 9 business e2e (live DB)', () => {
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
  const reservationAllocation = new ReservationAllocationService(audit);
  const products = new ProductsService(prisma as never, audit, warehouseLock, stockFifo);
  const supplies = new SuppliesService(
    prisma as never,
    audit,
    warehouseLock,
    reservationAllocation,
  );
  const inventories = new InventoriesService(
    prisma as never,
    audit,
    warehouseLock,
    stockFifo,
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
  let supplierId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];
  const orderIds: string[] = [];
  const bouquetIds: string[] = [];
  const inventoryIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Biz E2E Dir',
    login: `biz_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-biz',
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
        login: `biz_d_${suffix}`,
        name: 'Biz E2E Dir',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorId = d.id;
    const supplier = await createTestSupplier(prisma, `Business E2E ${suffix}`);
    supplierId = supplier.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      if (inventoryIds.length) {
        const items = await prisma.inventoryItem.findMany({
          where: { inventorySessionId: { in: inventoryIds } },
          select: { id: true },
        });
        const itemIds = items.map((i) => i.id);
        const invLots = await prisma.stockLot.findMany({
          where: { inventoryItemId: { in: itemIds } },
          select: { id: true },
        });
        const invLotIds = invLots.map((l) => l.id);
        const invMovements = await prisma.stockMovement.findMany({
          where: { sourceType: 'INVENTORY', sourceId: { in: inventoryIds } },
          select: { id: true },
        });
        const invMovIds = invMovements.map((m) => m.id);
        if (invMovIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: invMovIds } },
          });
          await prisma.stockMovement.deleteMany({ where: { id: { in: invMovIds } } });
        }
        if (invLotIds.length) {
          await prisma.stockLot.deleteMany({ where: { id: { in: invLotIds } } });
        }
        await prisma.inventoryItem.deleteMany({
          where: { inventorySessionId: { in: inventoryIds } },
        });
        await prisma.inventorySession.deleteMany({ where: { id: { in: inventoryIds } } });
      }

      if (orderIds.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
        const items = await prisma.orderItem.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true },
        });
        const itemIds = items.map((i) => i.id);
        await prisma.orderItemComponent.deleteMany({ where: { orderItemId: { in: itemIds } } });
        const orderMovs = await prisma.stockMovement.findMany({
          where: { sourceType: 'Order', sourceId: { in: orderIds } },
          select: { id: true },
        });
        const orderMovIds = orderMovs.map((m) => m.id);
        if (orderMovIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: orderMovIds } },
          });
          await prisma.stockMovement.deleteMany({ where: { id: { in: orderMovIds } } });
        }
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      if (bouquetIds.length) {
        await prisma.bouquetItem.deleteMany({ where: { bouquetId: { in: bouquetIds } } });
        await prisma.bouquet.deleteMany({ where: { id: { in: bouquetIds } } });
      }

      if (supplyIds.length) {
        const lots = await prisma.stockLot.findMany({
          where: { supplyItem: { supplyId: { in: supplyIds } } },
          select: { id: true },
        });
        const lotIds = lots.map((l) => l.id);
        if (lotIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockLotId: { in: lotIds } },
          });
          await prisma.stockLot.deleteMany({ where: { id: { in: lotIds } } });
        }
        const supplyMovs = await prisma.stockMovement.findMany({
          where: { sourceType: 'Supply', sourceId: { in: supplyIds } },
          select: { id: true },
        });
        const supplyMovIds = supplyMovs.map((m) => m.id);
        if (supplyMovIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: supplyMovIds } },
          });
          await prisma.stockMovement.deleteMany({ where: { id: { in: supplyMovIds } } });
        }
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      if (supplierId) {
        await deleteTestSuppliers(prisma, [supplierId]);
      }

      if (productIds.length) {
        await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }

      if (directorId) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: directorId } });
        await prisma.user.delete({ where: { id: directorId } }).catch(() => undefined);
      }
    } finally {
      await prisma.$disconnect();
    }
  }, 180_000);

  async function flower(name: string, salePrice = '20.00'): Promise<string> {
    const created = await products.create(
      director(),
      {
        name: `${name}_${suffix}`,
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice,
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
    documentDate = '2026-09-01',
  ): Promise<void> {
    const draft = await supplies.create(
      director(),
      {
        documentDate,
        supplierId,
        items: [{ productId, quantity, unitPurchasePrice }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
  }

  it('full flow: products → supply → bouquet → shortage → restock → READY → COMPLETED FIFO/COGS', async () => {
    if (!ready) return;

    const rose = await flower('Rose', '10.00');
    const tulip = await flower('Tulip', '8.00');

    await postSupply(rose, 5, '10.00', '2026-09-01');
    await new Promise((r) => setTimeout(r, 40));
    await postSupply(rose, 10, '12.00', '2026-09-02');
    await postSupply(tulip, 20, '3.00', '2026-09-01');

    const bouquet = await bouquets.create(
      director(),
      {
        name: `BizBq_${suffix}`,
        salePrice: '55.00',
        items: [
          { productId: rose, quantity: 3 },
          { productId: tulip, quantity: 5 },
        ],
      },
      {},
    );
    bouquetIds.push(bouquet.id);

    const day = orders.businessTime().businessDate;

    // Ask for more roses than free stock after prior reservation pressure: 20 roses needed via product line.
    const shortOrder = await orders.create(
      director(),
      {
        customerName: 'Shortage Buyer',
        customerPhone: '+375291000001',
        fulfillmentType: FulfillmentType.DELIVERY,
        fulfillmentDate: day,
        deliveryAddressText: 'Minsk, Test 1',
        items: [
          { itemType: OrderItemType.PRODUCT, productId: rose, quantity: 20 },
          { itemType: OrderItemType.BOUQUET, bouquetId: bouquet.id, quantity: 1 },
        ],
      },
      {},
    );
    orderIds.push(shortOrder.id);
    // 15 roses on hand; bouquet needs 3 + product 20 = 23 roses required → shortage.
    expect(shortOrder.hasShortage).toBe(true);

    await expect(
      orders.changeStatus(
        director(),
        shortOrder.id,
        { status: OrderStatus.READY, expectedVersion: shortOrder.version },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ORDER_HAS_SHORTAGE' });

    await postSupply(rose, 20, '11.00', '2026-09-03');

    const refreshed = await orders.getById(director(), shortOrder.id);
    expect(refreshed.hasShortage).toBe(false);

    const readyOrder = await orders.changeStatus(
      director(),
      shortOrder.id,
      { status: OrderStatus.READY, expectedVersion: refreshed.version },
      {},
    );
    expect(readyOrder.status).toBe(OrderStatus.READY);

    const completed = await orders.changeStatus(
      director(),
      readyOrder.id,
      { status: OrderStatus.COMPLETED, expectedVersion: readyOrder.version },
      {},
    );
    expect(completed.status).toBe(OrderStatus.COMPLETED);
    expect(completed.hasShortage).toBe(false);
    expect(completed.hasUncostedConsumption).toBe(false);
    // Roses consumed: 20 (product) + 3 (bouquet) = 23 → 5@10 + 10@12 + 8@11 = 50+120+88 = 258
    // Tulips: 5@3 = 15 → total COGS 273
    expect(completed.actualCost).toBe('273.00');

    const roseLots = await prisma.stockLot.findMany({
      where: { productId: rose, reversedAt: null },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });
    expect(roseLots[0]!.remainingQuantity).toBe(0);
    expect(roseLots[1]!.remainingQuantity).toBe(0);
    expect(roseLots[2]!.remainingQuantity).toBe(12); // 20 - 8

    const sales = await prisma.stockMovement.findMany({
      where: {
        sourceType: 'Order',
        sourceId: shortOrder.id,
        type: StockMovementType.SALE,
      },
    });
    expect(sales.length).toBeGreaterThanOrEqual(2);
    expect(sales.reduce((s, m) => s + Math.abs(m.quantity), 0)).toBe(23 + 5);

    const stockRose = await prisma.productStock.findUniqueOrThrow({ where: { productId: rose } });
    expect(stockRose.quantityOnHand).toBe(12);
    expect(stockRose.quantityReserved).toBe(0);
  });

  it('cancel reallocates released stock to shortage order', async () => {
    if (!ready) return;
    const productId = await flower('CancelAlloc');
    await postSupply(productId, 10, '3.00');
    const day = orders.businessTime().businessDate;

    const a = await orders.create(
      director(),
      {
        customerName: 'CancelA',
        customerPhone: '+375291000010',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: day,
        fulfillmentTimeFrom: '09:00',
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 10 }],
      },
      {},
    );
    const b = await orders.create(
      director(),
      {
        customerName: 'CancelB',
        customerPhone: '+375291000011',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: day,
        fulfillmentTimeFrom: '10:00',
        items: [{ itemType: OrderItemType.PRODUCT, productId, quantity: 6 }],
      },
      {},
    );
    orderIds.push(a.id, b.id);

    expect(a.hasShortage).toBe(false);
    expect(b.hasShortage).toBe(true);

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

    const bDetail = await orders.getById(director(), b.id);
    expect(bDetail.hasShortage).toBe(false);
  });

  it('inventory freeze blocks supply; surplus allocates; below reserved rejects', async () => {
    if (!ready) return;
    const p = await flower('InvFreeze');
    await postSupply(p, 10, '4.00');

    const session = await inventories.createAndStart(director(), {}, {});
    inventoryIds.push(session.id);
    expect(session.status).toBe(InventoryStatus.IN_PROGRESS);

    const blocked = await supplies.create(
      director(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId: p, quantity: 1, unitPurchasePrice: '4.00' }],
      },
      {},
    );
    supplyIds.push(blocked.id);
    await expect(supplies.post(director(), blocked.id, {})).rejects.toMatchObject({
      code: 'INVENTORY_IN_PROGRESS',
    });

    // Surplus path: count above on-hand → uncosted inventory lot
    const detail = await inventories.getById(director(), session.id);
    for (const item of detail.items) {
      const qty = item.productId === p ? 14 : item.expectedQuantity;
      await inventories.updateItem(director(), session.id, item.id, { countedQuantity: qty }, {});
    }
    const completed = await inventories.complete(director(), session.id, {});
    expect(completed.status).toBe(InventoryStatus.COMPLETED);

    const surplus = await prisma.stockLot.findFirst({
      where: { productId: p, sourceType: StockLotSource.INVENTORY },
    });
    expect(surplus?.unitPurchasePrice).toBeNull();
    expect(surplus?.remainingQuantity).toBe(4);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId: p } });
    expect(stock.quantityOnHand).toBe(14);

    // Below reserved reject on a fresh session
    const q = await flower('InvReserved');
    await postSupply(q, 10, '2.00');
    await prisma.productStock.update({
      where: { productId: q },
      data: { quantityReserved: 4 },
    });
    const session2 = await inventories.createAndStart(director(), {}, {});
    inventoryIds.push(session2.id);
    const d2 = await inventories.getById(director(), session2.id);
    for (const item of d2.items) {
      const qty = item.productId === q ? 3 : item.expectedQuantity;
      await inventories.updateItem(director(), session2.id, item.id, { countedQuantity: qty }, {});
    }
    await expect(inventories.complete(director(), session2.id, {})).rejects.toMatchObject({
      code: 'INVENTORY_BELOW_RESERVED',
    });
    await expect(inventories.complete(director(), session2.id, {})).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
