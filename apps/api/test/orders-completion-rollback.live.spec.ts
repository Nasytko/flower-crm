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

describe('Phase 9 order completion rollback (live DB)', () => {
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
    name: 'Rollback Dir',
    login: `rb_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-rb',
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
        login: `rb_d_${suffix}`,
        name: 'Rollback Dir',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorId = d.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    delete process.env.ORDER_COMPLETION_FAIL_AFTER_FIRST;
    try {
      if (orderIds.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
        const items = await prisma.orderItem.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true },
        });
        const itemIds = items.map((i) => i.id);
        await prisma.orderItemComponent.deleteMany({ where: { orderItemId: { in: itemIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      if (supplyIds.length) {
        const lots = await prisma.stockLot.findMany({
          where: { supplyItem: { supplyId: { in: supplyIds } } },
          select: { id: true },
        });
        const lotIds = lots.map((l) => l.id);
        const movs = await prisma.stockMovement.findMany({
          where: {
            OR: [
              { sourceType: 'Order', sourceId: { in: orderIds } },
              { productId: { in: productIds } },
            ],
          },
          select: { id: true },
        });
        const movIds = movs.map((m) => m.id);
        if (movIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: movIds } },
          });
          await prisma.stockMovement.deleteMany({ where: { id: { in: movIds } } });
        }
        if (lotIds.length) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockLotId: { in: lotIds } },
          });
          await prisma.stockLot.deleteMany({ where: { id: { in: lotIds } } });
        }
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
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  async function flower(name: string): Promise<string> {
    const created = await products.create(
      director(),
      {
        name: `${name}_${suffix}`,
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '15.00',
      },
      {},
    );
    productIds.push(created.id);
    return created.id;
  }

  async function postSupply(productId: string, quantity: number, price: string): Promise<void> {
    const draft = await supplies.create(
      director(),
      {
        documentDate: '2026-09-10',
        items: [{ productId, quantity, unitPurchasePrice: price }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
  }

  it('mid-completion failure rolls back status, stock, SALE, reservations', async () => {
    if (!ready) return;

    const a = await flower('A');
    const b = await flower('B');
    // Lexicographic productId order drives consume loop; both get stock.
    await postSupply(a, 5, '4.00');
    await postSupply(b, 5, '6.00');

    const day = orders.businessTime().businessDate;
    const created = await orders.create(
      director(),
      {
        customerName: 'Rollback Customer',
        customerPhone: '+375291110000',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: day,
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId: a,
            quantity: 2,
          },
          {
            itemType: OrderItemType.PRODUCT,
            productId: b,
            quantity: 3,
          },
        ],
      },
      {},
    );
    orderIds.push(created.id);
    expect(created.hasShortage).toBe(false);

    const readyOrder = await orders.changeStatus(
      director(),
      created.id,
      { status: OrderStatus.READY, expectedVersion: created.version },
      {},
    );

    const stockBefore = await prisma.productStock.findMany({
      where: { productId: { in: [a, b] } },
      orderBy: { productId: 'asc' },
    });
    const reservationsBefore = await prisma.stockReservation.findMany({
      where: { orderId: created.id },
      orderBy: { productId: 'asc' },
    });
    expect(reservationsBefore).toHaveLength(2);

    process.env.ORDER_COMPLETION_FAIL_AFTER_FIRST = '1';
    try {
      await expect(
        orders.changeStatus(
          director(),
          readyOrder.id,
          { status: OrderStatus.COMPLETED, expectedVersion: readyOrder.version },
          {},
        ),
      ).rejects.toBeInstanceOf(AppError);
    } finally {
      delete process.env.ORDER_COMPLETION_FAIL_AFTER_FIRST;
    }

    const after = await orders.getById(director(), created.id);
    expect(after.status).toBe(OrderStatus.READY);
    expect(after.actualCost).toBeNull();

    const stockAfter = await prisma.productStock.findMany({
      where: { productId: { in: [a, b] } },
      orderBy: { productId: 'asc' },
    });
    expect(stockAfter).toEqual(stockBefore);

    const sales = await prisma.stockMovement.findMany({
      where: { sourceType: 'Order', sourceId: created.id, type: StockMovementType.SALE },
    });
    expect(sales).toHaveLength(0);

    const reservationsAfter = await prisma.stockReservation.findMany({
      where: { orderId: created.id },
      orderBy: { productId: 'asc' },
    });
    expect(reservationsAfter).toEqual(reservationsBefore);
  });
});
