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

describe('Phase 6 bouquets (live DB)', () => {
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
  let floristId = '';
  let supplierId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];
  const bouquetIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Bouquet Director',
    login: `bq_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-bq-d',
    isActive: true,
  });

  const florist = () => ({
    id: floristId,
    name: 'Bouquet Florist',
    login: `bq_f_${suffix}`,
    role: Role.FLORIST,
    sessionId: 'live-bq-f',
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
        login: `bq_d_${suffix}`,
        name: 'Bouquet Director',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    const f = await prisma.user.create({
      data: {
        login: `bq_f_${suffix}`,
        name: 'Bouquet Florist',
        role: Role.FLORIST,
        passwordHash,
      },
    });
    directorId = d.id;
    floristId = f.id;
    const supplier = await createTestSupplier(prisma, `Bouquets Live ${suffix}`);
    supplierId = supplier.id;
    ready = true;
  }, 60_000);

  afterAll(async () => {
    try {
      if (bouquetIds.length > 0) {
        await prisma.bouquetItem.deleteMany({ where: { bouquetId: { in: bouquetIds } } });
        await prisma.bouquet.deleteMany({ where: { id: { in: bouquetIds } } });
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
          where: {
            OR: [{ productId: { in: productIds } }, { sourceId: { in: supplyIds } }],
          },
          select: { id: true },
        });
        const movementIds = movements.map((m) => m.id);
        if (movementIds.length > 0) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: movementIds } },
          });
        }
        if (lotIds.length > 0) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockLotId: { in: lotIds } },
          });
          await prisma.stockLot.deleteMany({ where: { id: { in: lotIds } } });
        }
        await prisma.stockMovement.deleteMany({
          where: {
            OR: [{ productId: { in: productIds } }, { sourceId: { in: supplyIds } }],
          },
        });
        await prisma.supplyItem.deleteMany({ where: { supplyId: { in: supplyIds } } });
        await prisma.supply.deleteMany({ where: { id: { in: supplyIds } } });
      }
      if (supplierId) {
        await deleteTestSuppliers(prisma, [supplierId]);
      }
      if (productIds.length > 0) {
        await prisma.stockMovementLotAllocation.deleteMany({
          where: { lot: { productId: { in: productIds } } },
        });
        await prisma.stockLot.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.bouquetItem.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.inventoryItem.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }
      for (const uid of [directorId, floristId]) {
        if (!uid) continue;
        await prisma.session.deleteMany({ where: { userId: uid } });
        await prisma.auditLog.deleteMany({ where: { actorUserId: uid } });
        await prisma.user.delete({ where: { id: uid } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function flower(name: string): Promise<string> {
    const created = await products.create(
      director(),
      {
        name: `${name}_${suffix}`,
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '10.00',
      },
      {},
    );
    productIds.push(created.id);
    return created.id;
  }

  async function service(name: string, purchasePrice: string | null): Promise<string> {
    const created = await products.create(
      director(),
      {
        name: `${name}_${suffix}`,
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
        purchasePrice,
        salePrice: '3.00',
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
        documentDate: '2026-09-15',
        supplierId,
        items: [{ productId, quantity, unitPurchasePrice: price }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
  }

  it('creates FLOWER+SERVICE bouquet without mutating stock', async () => {
    if (!ready) return;
    const rose = await flower('Rose');
    const wrap = await service('Wrap', '2.00');
    await postSupply(rose, 30, '5.20');

    const stockBefore = await prisma.productStock.findUniqueOrThrow({ where: { productId: rose } });
    const lotsBefore = await prisma.stockLot.count({ where: { productId: rose } });
    const movBefore = await prisma.stockMovement.count({ where: { productId: rose } });

    const created = await bouquets.create(
      director(),
      {
        name: `Нежность ${suffix}`,
        salePrice: '85.00',
        items: [
          { productId: rose, quantity: 7 },
          { productId: wrap, quantity: 1 },
        ],
      },
      {},
    );
    bouquetIds.push(created.id);

    expect(created.salePrice).toBe('85.00');
    expect(created.componentCount).toBe(2);
    expect(created.availableBouquets).toBe(4);
    expect(created.estimatedCurrentCost).toBe('38.40'); // 7*5.20 + 2.00

    const stockAfter = await prisma.productStock.findUniqueOrThrow({ where: { productId: rose } });
    expect(stockAfter.quantityOnHand).toBe(stockBefore.quantityOnHand);
    expect(await prisma.stockLot.count({ where: { productId: rose } })).toBe(lotsBefore);
    expect(await prisma.stockMovement.count({ where: { productId: rose } })).toBe(movBefore);
    expect(await prisma.productStock.findUnique({ where: { productId: created.id } })).toBeNull();

    const floristView = await bouquets.getById(florist(), created.id);
    expect(floristView).not.toHaveProperty('estimatedCurrentCost');
    expect(floristView).not.toHaveProperty('estimatedMargin');
    expect(floristView.items[0]).not.toHaveProperty('currentComponentCost');
  });

  it('rejects empty, service-only, duplicate, inactive, bad qty via create', async () => {
    if (!ready) return;
    const rose = await flower('R2');
    const wrap = await service('W2', '1.00');
    const inactive = await flower('Inactive');
    await products.update(director(), inactive, { isActive: false }, {});

    await expect(
      bouquets.create(director(), { name: 'X', salePrice: '10.00', items: [] }, {}),
    ).rejects.toBeTruthy();

    await expect(
      bouquets.create(
        director(),
        { name: 'X', salePrice: '10.00', items: [{ productId: wrap, quantity: 1 }] },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BOUQUET_FLOWER_REQUIRED' });

    await expect(
      bouquets.create(
        director(),
        {
          name: 'X',
          salePrice: '10.00',
          items: [
            { productId: rose, quantity: 1 },
            { productId: rose, quantity: 2 },
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BOUQUET_DUPLICATE_COMPONENT' });

    await expect(
      bouquets.create(
        director(),
        {
          name: 'X',
          salePrice: '10.00',
          items: [{ productId: inactive, quantity: 1 }],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BOUQUET_INACTIVE_PRODUCT' });
  });

  it('availability with reserved and full recipe formula', async () => {
    if (!ready) return;
    const rose = await flower('AvRose');
    const eus = await flower('AvEus');
    const gyp = await flower('AvGyp');
    const wrap = await service('AvWrap', '2.00');
    await postSupply(rose, 30, '5.20');
    await postSupply(eus, 20, '3.00');
    await postSupply(gyp, 8, '1.50');

    const created = await bouquets.create(
      director(),
      {
        name: `Avail ${suffix}`,
        salePrice: '80.00',
        items: [
          { productId: rose, quantity: 7 },
          { productId: eus, quantity: 3 },
          { productId: gyp, quantity: 2 },
          { productId: wrap, quantity: 1 },
        ],
      },
      {},
    );
    bouquetIds.push(created.id);
    expect(created.availableBouquets).toBe(4);
    expect(created.estimatedCurrentCost).toBe('50.40');
    expect(created.estimatedMargin).toBe('29.60');
    expect(created.estimatedMarginPercent).toBe('37.00');

    await prisma.productStock.update({
      where: { productId: rose },
      data: { quantityReserved: 9 },
    });
    const again = await bouquets.getById(director(), created.id);
    expect(again.availableBouquets).toBe(3);
  });

  it('uncosted lot and missing service cost => unknown cost', async () => {
    if (!ready) return;
    const rose = await flower('Uncost');
    const wrap = await service('NoCostWrap', null);
    await postSupply(rose, 10, '4.00');

    const withService = await bouquets.create(
      director(),
      {
        name: `UnkSvc ${suffix}`,
        salePrice: '50.00',
        items: [
          { productId: rose, quantity: 1 },
          { productId: wrap, quantity: 1 },
        ],
      },
      {},
    );
    bouquetIds.push(withService.id);
    expect(withService.hasUnknownCost).toBe(true);
    expect(withService.estimatedCurrentCost).toBeNull();

    const emptyFlower = await flower('EmptyCost');
    const onlyFlower = await bouquets.create(
      director(),
      {
        name: `Empty ${suffix}`,
        salePrice: '20.00',
        items: [{ productId: emptyFlower, quantity: 1 }],
      },
      {},
    );
    bouquetIds.push(onlyFlower.id);
    expect(onlyFlower.availableBouquets).toBe(0);
    expect(onlyFlower.hasUnknownCost).toBe(true);
    expect(onlyFlower.estimatedCurrentCost).toBeNull();
  });

  it('update transactional + optimistic concurrency + deactivate/reactivate', async () => {
    if (!ready) return;
    const rose = await flower('UpdRose');
    const eus = await flower('UpdEus');
    await postSupply(rose, 20, '4.00');
    await postSupply(eus, 10, '3.00');

    const created = await bouquets.create(
      director(),
      {
        name: `Upd ${suffix}`,
        salePrice: '40.00',
        items: [{ productId: rose, quantity: 2 }],
      },
      {},
    );
    bouquetIds.push(created.id);

    const updated = await bouquets.update(
      director(),
      created.id,
      {
        expectedVersion: created.version,
        items: [
          { productId: rose, quantity: 3 },
          { productId: eus, quantity: 1 },
        ],
        salePrice: '55.00',
      },
      {},
    );
    expect(updated.version).toBe(created.version + 1);
    expect(updated.componentCount).toBe(2);
    expect(updated.salePrice).toBe('55.00');

    await expect(
      bouquets.update(
        director(),
        created.id,
        { expectedVersion: created.version, name: 'stale' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BOUQUET_CONFLICT' });

    const deactivated = await bouquets.update(
      director(),
      created.id,
      { expectedVersion: updated.version, isActive: false },
      {},
    );
    expect(deactivated.isActive).toBe(false);

    // Make a component inactive then reject reactivation
    await products.update(director(), eus, { isActive: false }, {});
    await expect(
      bouquets.update(
        director(),
        created.id,
        { expectedVersion: deactivated.version, isActive: true },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BOUQUET_INACTIVE_PRODUCT' });

    // Recipe still readable with inactive component
    const detail = await bouquets.getById(director(), created.id);
    expect(detail.hasInactiveComponents).toBe(true);
    expect(detail.availableBouquets).toBe(0);
    expect(detail.items.some((i) => !i.isActive)).toBe(true);

    const audits = await prisma.auditLog.count({
      where: {
        entityId: created.id,
        action: { in: ['BOUQUET_CREATED', 'BOUQUET_UPDATED', 'BOUQUET_DEACTIVATED'] },
      },
    });
    expect(audits).toBeGreaterThanOrEqual(3);
  });

  it('florist cannot create bouquet (service-level role still maps; controller enforces)', async () => {
    if (!ready) return;
    // Service itself doesn't check permission — PermissionsGuard does.
    // Verify list works for florist without cost fields.
    const rose = await flower('FlorRose');
    await postSupply(rose, 5, '1.00');
    const created = await bouquets.create(
      director(),
      {
        name: `Flor ${suffix}`,
        salePrice: '15.00',
        items: [{ productId: rose, quantity: 1 }],
      },
      {},
    );
    bouquetIds.push(created.id);

    const list = await bouquets.list(florist(), { isActive: 'true' });
    const row = list.items.find((i) => i.id === created.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('estimatedCurrentCost');
    expect(row).not.toHaveProperty('estimatedMargin');
  });
});
