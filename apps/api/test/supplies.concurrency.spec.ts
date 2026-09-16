import { Role, ProductType, Unit, StockMovementType, SupplyStatus } from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { hashPassword } from '../src/common/security/password';
import { AppError } from '../src/common/errors/app-error';
import { cancelLeftoverInventories, createTestSupplier, deleteTestSuppliers } from './helpers/live-db';

describe('Phase 4 supplies + FIFO (live DB)', () => {
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
  let supplierId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];

  const actor = () => ({
    id: actorId,
    name: 'Supply Tester',
    login: `sup_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-supply-test',
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
        login: `sup_${suffix}`,
        name: 'Supply Tester',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    actorId = user.id;
    const supplier = await createTestSupplier(prisma, `Supply Test ${suffix}`);
    supplierId = supplier.id;
    ready = true;
  }, 60_000);

  afterAll(async () => {
    try {
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
  });

  async function flower(name: string): Promise<string> {
    const created = await products.create(
      actor(),
      {
        name,
        sku: `P4-${suffix}-${name}`.slice(0, 60),
        type: ProductType.FLOWER,
        unit: Unit.PIECE,
        salePrice: '10.00',
      },
      {},
    );
    productIds.push(created.id);
    return created.id;
  }

  function trackSupply(id: string) {
    supplyIds.push(id);
  }

  it('posts supply once under concurrent double-post', async () => {
    if (!ready) return;
    const productId = await flower(`DP ${suffix}`);
    const draft = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId, quantity: 20, unitPurchasePrice: '5.00' }],
      },
      {},
    );
    trackSupply(draft.id);

    const results = await Promise.allSettled([
      supplies.post(actor(), draft.id, {}),
      supplies.post(actor(), draft.id, {}),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(1);
    expect((fail[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
    expect((fail[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'SUPPLY_ALREADY_POSTED',
    });

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(20);
    const lots = await prisma.stockLot.findMany({ where: { productId } });
    expect(lots).toHaveLength(1);
    expect(lots[0]!.remainingQuantity).toBe(20);
    const mov = await prisma.stockMovement.count({
      where: { productId, type: StockMovementType.SUPPLY },
    });
    expect(mov).toBe(1);
  });

  it('rolls back multi-product post when a product is inactive mid-path', async () => {
    if (!ready) return;
    const a = await flower(`MP-A ${suffix}`);
    const b = await flower(`MP-B ${suffix}`);
    const c = await flower(`MP-C ${suffix}`);

    const draft = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [
          { productId: a, quantity: 50, unitPurchasePrice: '1.00' },
          { productId: b, quantity: 20, unitPurchasePrice: '2.00' },
          { productId: c, quantity: 30, unitPurchasePrice: '3.00' },
        ],
      },
      {},
    );
    trackSupply(draft.id);

    await prisma.product.update({ where: { id: c }, data: { isActive: false } });

    await expect(supplies.post(actor(), draft.id, {})).rejects.toMatchObject({
      code: 'PRODUCT_INACTIVE',
    });

    const stockA = await prisma.productStock.findUniqueOrThrow({ where: { productId: a } });
    const stockB = await prisma.productStock.findUniqueOrThrow({ where: { productId: b } });
    const stockC = await prisma.productStock.findUniqueOrThrow({ where: { productId: c } });
    expect(stockA.quantityOnHand).toBe(0);
    expect(stockB.quantityOnHand).toBe(0);
    expect(stockC.quantityOnHand).toBe(0);
    expect(await prisma.stockLot.count({ where: { productId: { in: [a, b, c] } } })).toBe(0);

    const still = await prisma.supply.findUniqueOrThrow({ where: { id: draft.id } });
    expect(still.status).toBe(SupplyStatus.DRAFT);
  });

  it('correction replaces untouched supply transactionally', async () => {
    if (!ready) return;
    const productId = await flower(`COR ${suffix}`);
    const original = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId, quantity: 50, unitPurchasePrice: '5.20' }],
      },
      {},
    );
    trackSupply(original.id);
    await supplies.post(actor(), original.id, {});

    const correction = await supplies.createCorrection(
      actor(),
      original.id,
      { reason: 'Ошибка количества' },
      {},
    );
    trackSupply(correction.id);

    await supplies.update(
      actor(),
      correction.id,
      {
        items: [{ productId, quantity: 45, unitPurchasePrice: '5.40' }],
      },
      {},
    );

    await supplies.post(actor(), correction.id, {});

    const orig = await prisma.supply.findUniqueOrThrow({ where: { id: original.id } });
    const corr = await prisma.supply.findUniqueOrThrow({ where: { id: correction.id } });
    expect(orig.status).toBe(SupplyStatus.CANCELLED);
    expect(corr.status).toBe(SupplyStatus.POSTED);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(45);

    const types = await prisma.stockMovement.findMany({
      where: { productId },
      orderBy: { createdAt: 'asc' },
    });
    expect(types.map((m) => m.quantity)).toEqual([50, -50, 45]);

    const activeLots = await prisma.stockLot.findMany({
      where: { productId, remainingQuantity: { gt: 0 } },
    });
    expect(activeLots).toHaveLength(1);
    expect(activeLots[0]!.remainingQuantity).toBe(45);
    expect(activeLots[0]!.unitPurchasePrice!.toFixed(2)).toBe('5.40');
  });

  it('blocks correction when lot partially consumed', async () => {
    if (!ready) return;
    const productId = await flower(`CON ${suffix}`);
    const supply = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId, quantity: 50, unitPurchasePrice: '4.00' }],
      },
      {},
    );
    trackSupply(supply.id);
    await supplies.post(actor(), supply.id, {});

    await products.writeOff(actor(), productId, { quantity: 10, reason: 'Испорчены цветы' }, {});

    await expect(
      supplies.createCorrection(actor(), supply.id, { reason: 'Попытка исправить' }, {}),
    ).rejects.toMatchObject({ code: 'SUPPLY_ALREADY_CONSUMED' });

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(40);
    const still = await prisma.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect(still.status).toBe(SupplyStatus.POSTED);
  });

  it('FIFO write-off allocates oldest lots first', async () => {
    if (!ready) return;
    const productId = await flower(`FIFO ${suffix}`);
    const s1 = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-01',
        supplierId,
        items: [{ productId, quantity: 10, unitPurchasePrice: '4.00' }],
      },
      {},
    );
    trackSupply(s1.id);
    await supplies.post(actor(), s1.id, {});

    // ensure second lot is newer
    await new Promise((r) => setTimeout(r, 20));

    const s2 = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-02',
        supplierId,
        items: [{ productId, quantity: 20, unitPurchasePrice: '5.00' }],
      },
      {},
    );
    trackSupply(s2.id);
    await supplies.post(actor(), s2.id, {});

    await products.writeOff(actor(), productId, { quantity: 15, reason: 'Списание FIFO тест' }, {});

    const lots = await prisma.stockLot.findMany({
      where: { productId },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });
    expect(lots[0]!.remainingQuantity).toBe(0);
    expect(lots[1]!.remainingQuantity).toBe(15);

    const movement = await prisma.stockMovement.findFirst({
      where: { productId, type: StockMovementType.MANUAL_WRITE_OFF },
      include: { allocations: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(movement!.quantity).toBe(-15);
    const allocQty = movement!.allocations.map((a) => a.quantity).sort((a, b) => a - b);
    expect(allocQty).toEqual([5, 10]);

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(15);
  });

  it('computes weighted average purchase cost', async () => {
    if (!ready) return;
    const productId = await flower(`AVG ${suffix}`);
    const s1 = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId, quantity: 5, unitPurchasePrice: '4.00' }],
      },
      {},
    );
    trackSupply(s1.id);
    await supplies.post(actor(), s1.id, {});
    const s2 = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId, quantity: 15, unitPurchasePrice: '5.00' }],
      },
      {},
    );
    trackSupply(s2.id);
    await supplies.post(actor(), s2.id, {});

    const listed = await products.getById(actor(), productId);
    expect(listed.averagePurchaseCost).toBe('4.75');
    expect(listed).not.toHaveProperty('purchasePrice');
  });

  it('rejects SERVICE in supply and omits costs for florist', async () => {
    if (!ready) return;
    const service = await products.create(
      actor(),
      {
        name: `Svc ${suffix}`,
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
        purchasePrice: '1.00',
        salePrice: '3.00',
      },
      {},
    );
    productIds.push(service.id);

    await expect(
      supplies.create(
        actor(),
        {
          documentDate: '2026-09-14',
          supplierId,
          items: [{ productId: service.id, quantity: 1, unitPurchasePrice: '1.00' }],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'SUPPLY_SERVICE_NOT_ALLOWED' });

    const flowerId = await flower(`FL ${suffix}`);
    const s = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        supplierId,
        items: [{ productId: flowerId, quantity: 3, unitPurchasePrice: '2.00' }],
      },
      {},
    );
    trackSupply(s.id);
    await supplies.post(actor(), s.id, {});

    const florist = {
      ...actor(),
      role: Role.FLORIST,
      login: 'florist',
      name: 'Florist',
    };
    const warehouse = await products.getById(florist, flowerId);
    expect(warehouse).not.toHaveProperty('averagePurchaseCost');
    expect(warehouse).not.toHaveProperty('purchasePrice');

    const supplyView = await supplies.getById(florist, s.id);
    expect(supplyView.totalAmount).toBeUndefined();
    expect(supplyView.items[0]!.unitPurchasePrice).toBeUndefined();
  });

  it('does not allow increasing stock via write-off', async () => {
    if (!ready) return;
    const productId = await flower(`WO ${suffix}`);
    await expect(
      products.writeOff(actor(), productId, { quantity: 0 as never, reason: 'bad' }, {}),
    ).rejects.toBeTruthy();

    // positive write-off with zero stock fails
    await expect(
      products.writeOff(actor(), productId, { quantity: 1, reason: 'нет остатка' }, {}),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId } });
    expect(stock.quantityOnHand).toBe(0);
  });
});
