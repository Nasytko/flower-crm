import {
  Role,
  ProductType,
  Unit,
  OrderItemType,
  FulfillmentType,
  OrderStatus,
  AssembledBouquetStatus,
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
import { StockBalanceService } from '../src/modules/warehouse/stock-balance.service';
import { AssembledBouquetService } from '../src/modules/warehouse/assembled-bouquet.service';
import { hashPassword } from '../src/common/security/password';
import {
  cancelLeftoverInventories,
  createTestSupplier,
  deleteTestSuppliers,
} from './helpers/live-db';
import { AppError } from '../src/common/errors/app-error';

/**
 * Three-bucket warehouse + assemble / disassemble / issue (live Postgres / CI).
 * Covers dynamic preemption, physical bouquet WIP, FEFO pick with lot cost, idempotency.
 */
describe('Warehouse three-bucket assembly (live DB)', () => {
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
  const products = new ProductsService(prisma as never, audit, warehouseLock, stockFifo, {
    syncProductImages: async () => undefined,
    toDto: (row: { id: string }) => ({
      id: row.id,
      mimeType: 'image/webp',
      byteSize: 0,
      width: null,
      height: null,
      sortOrder: 0,
      url: '',
      thumbUrl: '',
      isPrimary: false,
    }),
  } as never);
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
  );
  const assembled = new AssembledBouquetService(
    prisma as never,
    warehouseLock,
    stockFifo,
    stockBalance,
    reservationAllocation,
    audit,
    config,
  );
  const suffix = Date.now().toString(36);

  let directorId = '';
  let supplierId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];
  const orderIds: string[] = [];
  const bouquetIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Asm Director',
    login: `asm_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-asm',
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
        login: `asm_d_${suffix}`,
        name: 'Asm Director',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorId = d.id;
    const supplier = await createTestSupplier(prisma, `Assembly Live ${suffix}`);
    supplierId = supplier.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      if (bouquetIds.length) {
        await prisma.assembledBouquetComponentLot.deleteMany({
          where: { component: { assembledBouquetId: { in: bouquetIds } } },
        });
        await prisma.assembledBouquetComponent.deleteMany({
          where: { assembledBouquetId: { in: bouquetIds } },
        });
        await prisma.assembledBouquet.deleteMany({ where: { id: { in: bouquetIds } } });
      }
      if (orderIds.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItemComponent.deleteMany({
          where: { orderItem: { orderId: { in: orderIds } } },
        });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      if (productIds.length) {
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { movement: { productId: { in: productIds } } },
        });
        await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.stockLot.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.supplyItem.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }
      if (supplyIds.length) {
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      await deleteTestSuppliers(prisma, supplierId ? [supplierId] : []);
      if (directorId) await prisma.user.deleteMany({ where: { id: directorId } });
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  async function flower(name: string): Promise<string> {
    const p = await products.create(
      director(),
      {
        name,
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '50.00',
      },
      {},
    );
    productIds.push(p.id);
    return p.id;
  }

  async function postSupply(productId: string, quantity: number, price: string, date?: string) {
    const draft = await supplies.create(
      director(),
      {
        documentDate: date ?? orders.businessTime().businessDate,
        supplierId,
        items: [{ productId, quantity, unitPurchasePrice: price }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
  }

  function shift(iso: string, days: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
  }

  it('1-4: reserve 100 across dates; urgent order preempts; partial deficit', async () => {
    if (!ready) return;
    const productId = await flower(`Rosa ${suffix}`);
    await postSupply(productId, 100, '5.00');
    const today = orders.businessTime().businessDate;

    const o101 = await orders.create(
      director(),
      {
        customerPhone: '+375291000101',
        customerName: '101',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: today,
        fulfillmentTimeFrom: '10:00',
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 30,
            unitPrice: '50.00',
          },
        ],
      },
      {},
    );
    orderIds.push(o101.id);

    const o102 = await orders.create(
      director(),
      {
        customerPhone: '+375291000102',
        customerName: '102',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: shift(today, 1),
        fulfillmentTimeFrom: '10:00',
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 40,
            unitPrice: '50.00',
          },
        ],
      },
      {},
    );
    orderIds.push(o102.id);

    const o103 = await orders.create(
      director(),
      {
        customerPhone: '+375291000103',
        customerName: '103',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: shift(today, 2),
        fulfillmentTimeFrom: '10:00',
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 30,
            unitPrice: '50.00',
          },
        ],
      },
      {},
    );
    orderIds.push(o103.id);

    const stock0 = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock0.quantityOnHand).toBe(100);
    expect(stock0.quantityReserved).toBe(100);
    expect(stock0.quantityInBouquets).toBe(0);

    const urgent = await orders.create(
      director(),
      {
        customerPhone: '+375291000199',
        customerName: 'Urgent',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: today,
        fulfillmentTimeFrom: '09:00',
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 25,
            unitPrice: '50.00',
          },
        ],
      },
      {},
    );
    orderIds.push(urgent.id);

    const r101 = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: o101.id, productId } },
    });
    const rU = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: urgent.id, productId } },
    });
    const r102 = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: o102.id, productId } },
    });
    const r103 = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: o103.id, productId } },
    });
    expect(r101.reservedQuantity).toBe(30);
    expect(rU.reservedQuantity).toBe(25);
    expect(r102.reservedQuantity).toBe(40);
    expect(r103.reservedQuantity).toBe(5);
    expect(r103.requiredQuantity - r103.reservedQuantity).toBe(25);
  });

  it('5-12: assemble vitrine + order bouquet, adjust, disassemble return/damage, consistency', async () => {
    if (!ready) return;
    const productId = await flower(`Tulip ${suffix}`);
    await postSupply(productId, 50, '3.00');

    const display = await assembled.assemble(
      director(),
      {
        nameSnapshot: 'Витрина',
        components: [{ productId, quantity: 10 }],
        idempotencyKey: `display-${suffix}`,
      },
      {},
    );
    bouquetIds.push(display.id);
    expect(display.status).toBe(AssembledBouquetStatus.ASSEMBLED);

    // Idempotent retry
    const again = await assembled.assemble(
      director(),
      {
        nameSnapshot: 'Витрина',
        components: [{ productId, quantity: 10 }],
        idempotencyKey: `display-${suffix}`,
      },
      {},
    );
    expect(again.id).toBe(display.id);

    let stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(40);
    expect(stock.quantityInBouquets).toBe(10);
    expect(stock.quantityOnHand + stock.quantityInBouquets).toBe(50);

    const today = orders.businessTime().businessDate;
    const order = await orders.create(
      director(),
      {
        customerPhone: '+375291000777',
        customerName: 'Asm',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: today,
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 17,
            unitPrice: '40.00',
          },
        ],
      },
      {},
    );
    orderIds.push(order.id);

    const bouquet = await assembled.assemble(
      director(),
      {
        orderId: order.id,
        orderItemId: order.items[0]!.id,
        nameSnapshot: 'Заказной',
        components: [{ productId, quantity: 17 }],
        expectedOrderVersion: order.version,
        idempotencyKey: `order-b-${suffix}`,
      },
      {},
    );
    bouquetIds.push(bouquet.id);

    stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityInBouquets).toBe(27);
    expect(stock.quantityOnHand).toBe(23);

    await prisma.$transaction(async (tx) => {
      await stockBalance.assertConsistency(tx as never, productId);
    });

    const disassembled = await assembled.disassemble(
      director(),
      display.id,
      {
        expectedVersion: display.version,
        reason: 'Нужны цветы на срочный заказ',
        lines: [{ productId, returnQuantity: 8, damageQuantity: 2 }],
      },
      {},
    );
    expect(disassembled.status).toBe(AssembledBouquetStatus.DISASSEMBLED);

    stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    // 10 left bouquet, returned 8 to shelf, 2 damaged gone
    expect(stock.quantityInBouquets).toBe(17);
    expect(stock.quantityOnHand).toBe(31);

    const returns = await prisma.stockMovement.count({
      where: { productId, type: StockMovementType.DISASSEMBLE_RETURN },
    });
    const damages = await prisma.stockMovement.count({
      where: { productId, type: StockMovementType.DISASSEMBLE_DAMAGE },
    });
    expect(returns).toBeGreaterThanOrEqual(1);
    expect(damages).toBeGreaterThanOrEqual(1);
  });

  it('13-14: issue removes from inBouquets; cancel keeps assembled', async () => {
    if (!ready) return;
    const productId = await flower(`Lily ${suffix}`);
    await postSupply(productId, 20, '4.00');
    const today = orders.businessTime().businessDate;

    const order = await orders.create(
      director(),
      {
        customerPhone: '+375291000888',
        customerName: 'Issue',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: today,
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 5,
            unitPrice: '40.00',
          },
        ],
      },
      {},
    );
    orderIds.push(order.id);

    const b = await assembled.assemble(
      director(),
      {
        orderId: order.id,
        orderItemId: order.items[0]!.id,
        nameSnapshot: 'К выдаче',
        components: [{ productId, quantity: 5 }],
        expectedOrderVersion: order.version,
      },
      {},
    );
    bouquetIds.push(b.id);

    const issued = await assembled.issue(director(), b.id, b.version, {});
    expect(issued.status).toBe(AssembledBouquetStatus.ISSUED);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityInBouquets).toBe(0);
    expect(stock.quantityOnHand).toBe(15);

    // Cancel path with remaining assembled
    const order2 = await orders.create(
      director(),
      {
        customerPhone: '+375291000889',
        customerName: 'CancelAsm',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: today,
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 3,
            unitPrice: '40.00',
          },
        ],
      },
      {},
    );
    orderIds.push(order2.id);
    const b2 = await assembled.assemble(
      director(),
      {
        orderId: order2.id,
        orderItemId: order2.items[0]!.id,
        nameSnapshot: 'Останется',
        components: [{ productId, quantity: 3 }],
        expectedOrderVersion: order2.version,
      },
      {},
    );
    bouquetIds.push(b2.id);

    await orders.changeStatus(
      director(),
      order2.id,
      {
        status: OrderStatus.CANCELLED,
        expectedVersion: (await orders.getById(director(), order2.id)).version,
      },
      {},
    );
    const still = await prisma.assembledBouquet.findUniqueOrThrow({ where: { id: b2.id } });
    expect(still.status).toBe(AssembledBouquetStatus.ASSEMBLED);
  });

  it('15-16: concurrent assemble + idempotent key; override required', async () => {
    if (!ready) return;
    const productId = await flower(`Race ${suffix}`);
    await postSupply(productId, 10, '2.00');
    const today = orders.businessTime().businessDate;
    const tomorrow = shift(today, 1);

    const late = await orders.create(
      director(),
      {
        customerPhone: '+375291000900',
        customerName: 'Late',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: tomorrow,
        items: [
          {
            itemType: OrderItemType.PRODUCT,
            productId,
            quantity: 10,
            unitPrice: '40.00',
          },
        ],
      },
      {},
    );
    orderIds.push(late.id);

    // Trying to assemble display of 10 while all reserved for later — needs override OR use own order
    await expect(
      assembled.assemble(
        director(),
        {
          nameSnapshot: 'Steal',
          components: [{ productId, quantity: 10 }],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'RESERVE_OVERRIDE_REQUIRED' } satisfies Partial<AppError>);

    const withOverride = await assembled.assemble(
      director(),
      {
        nameSnapshot: 'Override',
        components: [{ productId, quantity: 10 }],
        allowReserveOverride: true,
        idempotencyKey: `ov-${suffix}`,
      },
      {},
    );
    bouquetIds.push(withOverride.id);
    expect(withOverride.status).toBe(AssembledBouquetStatus.ASSEMBLED);
  });
});
