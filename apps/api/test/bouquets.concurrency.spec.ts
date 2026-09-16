import { Role, ProductType, Unit } from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { BouquetsService } from '../src/modules/bouquets/bouquets.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { hashPassword } from '../src/common/security/password';
import { cancelLeftoverInventories, createTestSupplier, deleteTestSuppliers } from './helpers/live-db';

describe('Bouquet optimistic concurrency (live DB)', () => {
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
  const bouquets = new BouquetsService(prisma as never, audit);
  const suffix = Date.now().toString(36);

  let directorId = '';
  let supplierId = '';
  let ready = false;
  let bouquetId = '';
  let roseId = '';
  let eucalyptusId = '';
  const productIds: string[] = [];
  const supplyIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Concurrency Director',
    login: `bq_c_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-bq-c',
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
        login: `bq_c_d_${suffix}`,
        name: 'Concurrency Director',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorId = d.id;
    const supplier = await createTestSupplier(prisma, `Bouquets Concurrency ${suffix}`);
    supplierId = supplier.id;

    const rose = await products.create(
      director(),
      { name: `ConcRose ${suffix}`, type: ProductType.FLOWER, unit: Unit.PIECE },
      {},
    );
    const eus = await products.create(
      director(),
      { name: `ConcEus ${suffix}`, type: ProductType.FLOWER, unit: Unit.PIECE },
      {},
    );
    roseId = rose.id;
    eucalyptusId = eus.id;
    productIds.push(roseId, eucalyptusId);

    const supply = await supplies.create(
      director(),
      {
        documentDate: '2026-09-15',
        supplierId,
        items: [
          { productId: roseId, quantity: 50, unitPurchasePrice: '4.00' },
          { productId: eucalyptusId, quantity: 50, unitPurchasePrice: '3.00' },
        ],
      },
      {},
    );
    supplyIds.push(supply.id);
    await supplies.post(director(), supply.id, {});

    const created = await bouquets.create(
      director(),
      {
        name: `Concurrent ${suffix}`,
        salePrice: '40.00',
        items: [{ productId: roseId, quantity: 2 }],
      },
      {},
    );
    bouquetId = created.id;

    await prisma.bouquet.update({
      where: { id: bouquetId },
      data: { version: 5 },
    });

    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      if (bouquetId) {
        await prisma.bouquetItem.deleteMany({ where: { bouquetId } });
        await prisma.bouquet.deleteMany({ where: { id: bouquetId } });
      }
      if (supplyIds.length > 0) {
        const items = await prisma.supplyItem.findMany({
          where: { supplyId: { in: supplyIds } },
          select: { id: true },
        });
        const itemIds = items.map((i) => i.id);
        const lots = await prisma.stockLot.findMany({
          where: { supplyItemId: { in: itemIds } },
          select: { id: true },
        });
        const lotIds = lots.map((l) => l.id);
        const movements = await prisma.stockMovement.findMany({
          where: { productId: { in: productIds } },
          select: { id: true },
        });
        const movementIds = movements.map((m) => m.id);
        if (lotIds.length > 0 || movementIds.length > 0) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: {
              OR: [{ stockLotId: { in: lotIds } }, { stockMovementId: { in: movementIds } }],
            },
          });
        }
        if (movementIds.length > 0) {
          await prisma.stockMovement.deleteMany({ where: { id: { in: movementIds } } });
        }
        if (lotIds.length > 0) {
          await prisma.stockLot.deleteMany({ where: { id: { in: lotIds } } });
        }
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      if (supplierId) {
        await deleteTestSuppliers(prisma, [supplierId]);
      }
      if (productIds.length > 0) {
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }
      if (directorId) {
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorUserId: directorId }, { entityId: bouquetId }] },
        });
        await prisma.user.delete({ where: { id: directorId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('allows only one concurrent recipe update at the same expectedVersion', async () => {
    if (!ready) {
      return;
    }

    const expectedVersion = 5;
    const actor = director();

    const results = await Promise.allSettled([
      bouquets.update(
        actor,
        bouquetId,
        {
          expectedVersion,
          name: 'Winner A',
          items: [
            { productId: roseId, quantity: 3 },
            { productId: eucalyptusId, quantity: 1 },
          ],
        },
        {},
      ),
      bouquets.update(
        actor,
        bouquetId,
        {
          expectedVersion,
          name: 'Winner B',
          items: [{ productId: roseId, quantity: 5 }],
        },
        {},
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'BOUQUET_CONFLICT' }),
    });

    const final = await bouquets.getById(actor, bouquetId);
    expect(final.version).toBe(6);

    const winner = fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<BouquetsService['update']>>
    >;
    expect(final.name).toBe(winner.value.name);
    expect(final.items.map((i) => ({ productId: i.productId, quantity: i.quantity }))).toEqual(
      winner.value.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );

    const updateAudits = await prisma.auditLog.count({
      where: { entityId: bouquetId, action: 'BOUQUET_UPDATED' },
    });
    expect(updateAudits).toBe(1);
  });
});
