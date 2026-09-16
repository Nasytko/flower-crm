import { Role, ProductType, Unit, StockMovementType } from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { hashPassword } from '../src/common/security/password';
import { AppError } from '../src/common/errors/app-error';
import { cancelLeftoverInventories } from './helpers/live-db';

/**
 * Live PostgreSQL concurrency for write-offs after supply posting.
 */
describe('ProductsService write-off concurrency (live DB)', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    it.skip('DATABASE_URL is not set', () => undefined);
    return;
  }

  const prisma = createPrismaClient(databaseUrl);
  const audit = new AuditService(prisma as never);
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
  const suffix = Date.now().toString(36);

  let actorId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];

  const actor = () => ({
    id: actorId,
    name: 'Stock Tester',
    login: `stock_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-stock-test',
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
    const user = await prisma.user.create({
      data: {
        login: `stock_${suffix}`,
        name: 'Stock Tester',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    actorId = user.id;
    ready = true;
  }, 60_000);

  afterAll(async () => {
    try {
      if (supplyIds.length > 0) {
        const items = await prisma.supplyItem.findMany({
          where: { supplyId: { in: supplyIds } },
        });
        const itemIds = items.map((i) => i.id);
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { lot: { supplyItemId: { in: itemIds } } },
        });
        await prisma.stockLot.deleteMany({ where: { supplyItemId: { in: itemIds } } });
        await prisma.stockMovement.deleteMany({
          where: { OR: [{ productId: { in: productIds } }, { sourceId: { in: supplyIds } }] },
        });
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      if (productIds.length > 0) {
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { lot: { productId: { in: productIds } } },
        });
        await prisma.stockLot.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ entityId: { in: productIds } }, { actorUserId: actorId }],
          },
        });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }
      if (actorId) {
        await prisma.session.deleteMany({ where: { userId: actorId } });
        await prisma.auditLog.deleteMany({ where: { actorUserId: actorId } });
        await prisma.user.delete({ where: { id: actorId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  async function createFlower(name: string): Promise<string> {
    const created = await products.create(
      actor(),
      {
        name,
        sku: `SKU-${suffix}-${name.replace(/\s+/g, '')}`.slice(0, 60),
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
      },
      {},
    );
    productIds.push(created.id);
    return created.id;
  }

  async function seedStock(productId: string, qty: number, price = '1.00'): Promise<void> {
    const draft = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        items: [{ productId, quantity: qty, unitPurchasePrice: price }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(actor(), draft.id, {});
  }

  it('allows only one of concurrent overselling write-offs', async () => {
    if (!ready) return;

    const productId = await createFlower(`Conc Race ${suffix}`);
    await seedStock(productId, 10);

    const results = await Promise.allSettled([
      products.writeOff(actor(), productId, { quantity: 7, reason: 'race A test' }, {}),
      products.writeOff(actor(), productId, { quantity: 6, reason: 'race B test' }, {}),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect([3, 4]).toContain(stock.quantityOnHand);
  });

  it('applies 20 concurrent write-offs after large supply without lost updates', async () => {
    if (!ready) return;

    const productId = await createFlower(`Conc Plus ${suffix}`);
    await seedStock(productId, 120);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        products.writeOff(
          actor(),
          productId,
          { quantity: 1, reason: `concurrent write-off ${i}` },
          {},
        ),
      ),
    );

    expect(results).toHaveLength(20);
    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(100);

    const offs = await prisma.stockMovement.count({
      where: { productId, quantity: -1, type: StockMovementType.MANUAL_WRITE_OFF },
    });
    expect(offs).toBe(20);
  });

  it('keeps ledger consistent through supply then write-offs', async () => {
    if (!ready) return;

    const productId = await createFlower(`Ledger ${suffix}`);
    await seedStock(productId, 16);

    for (const qty of [3, 4, 1]) {
      await products.writeOff(actor(), productId, { quantity: qty, reason: `ledger -${qty}` }, {});
    }

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(8);

    const movements = await prisma.stockMovement.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const sum = movements.reduce((acc, m) => acc + m.quantity, 0);
    expect(sum).toBe(8);
    expect(movements.at(-1)?.balanceAfter).toBe(8);
  });

  it('does not create ProductStock for SERVICE', async () => {
    if (!ready) return;

    const serviceProduct = await products.create(
      actor(),
      {
        name: `Service ${suffix}`,
        sku: '   ',
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
      },
      {},
    );
    productIds.push(serviceProduct.id);

    expect(serviceProduct.sku).toBeNull();
    const stock = await prisma.productStock.findUnique({ where: { productId: serviceProduct.id } });
    expect(stock).toBeNull();

    await expect(
      products.writeOff(actor(), serviceProduct.id, { quantity: 1, reason: 'not allowed' }, {}),
    ).rejects.toMatchObject({ code: 'STOCK_NOT_SUPPORTED' });
  });
});
