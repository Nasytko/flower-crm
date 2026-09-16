import {
  Role,
  ProductType,
  Unit,
  StockMovementType,
  InventoryStatus,
  StockLotSource,
} from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { InventoriesService } from '../src/modules/inventories/inventories.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { hashPassword } from '../src/common/security/password';
import { AppError } from '../src/common/errors/app-error';
import { cancelLeftoverInventories } from './helpers/live-db';

describe('Phase 5 inventory (live DB)', () => {
  jest.setTimeout(90_000);
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
  const inventories = new InventoriesService(
    prisma as never,
    audit,
    warehouseLock,
    stockFifo,
    reservationAllocation,
  );
  const suffix = Date.now().toString(36);

  let actorId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];
  const inventoryIds: string[] = [];

  const actor = () => ({
    id: actorId,
    name: 'Inventory Tester',
    login: `inv_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-inv-test',
    isActive: true,
  });

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return;
    }
    // Clear leftover freezes from prior interrupted runs.
    await cancelLeftoverInventories(prisma);
    const passwordHash = await hashPassword('LiveTest123!');
    const user = await prisma.user.create({
      data: {
        login: `inv_${suffix}`,
        name: 'Inventory Tester',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    actorId = user.id;
    ready = true;
  }, 60_000);

  afterAll(async () => {
    try {
      if (inventoryIds.length > 0) {
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
        const invMovementIds = invMovements.map((m) => m.id);
        if (invMovementIds.length > 0) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockMovementId: { in: invMovementIds } },
          });
        }
        if (invLotIds.length > 0) {
          await prisma.stockMovementLotAllocation.deleteMany({
            where: { stockLotId: { in: invLotIds } },
          });
          await prisma.stockLot.deleteMany({ where: { id: { in: invLotIds } } });
        }
        await prisma.stockMovement.deleteMany({
          where: { sourceType: 'INVENTORY', sourceId: { in: inventoryIds } },
        });
        await prisma.inventoryItem.deleteMany({
          where: { inventorySessionId: { in: inventoryIds } },
        });
        await prisma.inventorySession.deleteMany({ where: { id: { in: inventoryIds } } });
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

      if (productIds.length > 0) {
        // Orphan inventory rows that referenced these products (other sessions).
        const leftoverItems = await prisma.inventoryItem.findMany({
          where: { productId: { in: productIds } },
          select: { id: true, inventorySessionId: true },
        });
        const leftoverItemIds = leftoverItems.map((i) => i.id);
        const leftoverSessionIds = [...new Set(leftoverItems.map((i) => i.inventorySessionId))];
        if (leftoverItemIds.length > 0) {
          const leftoverLots = await prisma.stockLot.findMany({
            where: { inventoryItemId: { in: leftoverItemIds } },
            select: { id: true },
          });
          const leftoverLotIds = leftoverLots.map((l) => l.id);
          if (leftoverLotIds.length > 0) {
            await prisma.stockMovementLotAllocation.deleteMany({
              where: { stockLotId: { in: leftoverLotIds } },
            });
            await prisma.stockLot.deleteMany({ where: { id: { in: leftoverLotIds } } });
          }
          await prisma.inventoryItem.deleteMany({ where: { id: { in: leftoverItemIds } } });
        }
        for (const sessionId of leftoverSessionIds) {
          const remaining = await prisma.inventoryItem.count({
            where: { inventorySessionId: sessionId },
          });
          if (remaining === 0) {
            await prisma.inventorySession
              .delete({ where: { id: sessionId } })
              .catch(() => undefined);
          }
        }

        await prisma.stockMovementLotAllocation.deleteMany({
          where: { lot: { productId: { in: productIds } } },
        });
        await prisma.stockLot.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.supplyItem.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.productStock.deleteMany({ where: { productId: { in: productIds } } });
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }
      if (actorId) {
        // Orphan drafts referencing the test actor (e.g. blocked posts).
        const leftoverSupplies = await prisma.supply.findMany({
          where: { createdByUserId: actorId },
          select: { id: true },
        });
        const leftoverSupplyIds = leftoverSupplies.map((s) => s.id);
        if (leftoverSupplyIds.length > 0) {
          await prisma.supplyItem.deleteMany({ where: { supplyId: { in: leftoverSupplyIds } } });
          await prisma.supply.deleteMany({ where: { id: { in: leftoverSupplyIds } } });
        }
        await prisma.session.deleteMany({ where: { userId: actorId } });
        await prisma.auditLog.deleteMany({ where: { actorUserId: actorId } });
        await prisma.user.delete({ where: { id: actorId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  async function flower(name: string): Promise<string> {
    const created = await products.create(
      actor(),
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

  async function postSupply(productId: string, quantity: number, price: string): Promise<string> {
    const draft = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        items: [{ productId, quantity, unitPurchasePrice: price }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(actor(), draft.id, {});
    return draft.id;
  }

  async function countAll(
    sessionId: string,
    overrides: Record<string, number> = {},
  ): Promise<void> {
    const detail = await inventories.getById(actor(), sessionId);
    for (const item of detail.items) {
      const qty = overrides[item.productId] ?? item.expectedQuantity;
      await inventories.updateItem(actor(), sessionId, item.id, { countedQuantity: qty }, {});
    }
  }

  it('snapshots flowers, excludes service, includes inactive with stock', async () => {
    if (!ready) return;
    const activeId = await flower('Active');
    const inactiveId = await flower('Inactive');
    const service = await products.create(
      actor(),
      {
        name: `Svc_${suffix}`,
        type: ProductType.SERVICE,
        unit: Unit.PIECE,
        salePrice: '1.00',
      },
      {},
    );
    productIds.push(service.id);

    await postSupply(activeId, 5, '2.00');
    await postSupply(inactiveId, 3, '2.00');
    await products.update(actor(), inactiveId, { isActive: false }, {});

    const session = await inventories.createAndStart(actor(), { comment: 'scope' }, {});
    inventoryIds.push(session.id);

    expect(session.status).toBe(InventoryStatus.IN_PROGRESS);
    const productIdsInSession = session.items.map((i) => i.productId);
    expect(productIdsInSession).toContain(activeId);
    expect(productIdsInSession).toContain(inactiveId);
    expect(productIdsInSession).not.toContain(service.id);

    const inactiveItem = session.items.find((i) => i.productId === inactiveId)!;
    expect(inactiveItem.expectedQuantity).toBe(3);
    expect(inactiveItem.countedQuantity).toBeNull();

    await inventories.cancel(actor(), session.id, { reason: 'cleanup scope test' }, {});
  });

  it('null count differs from zero; blocks supply/write-off; FIFO negative and uncosted positive', async () => {
    if (!ready) return;

    const a = await flower('A');
    const b = await flower('B');
    const c = await flower('C');

    // A: two lots for FIFO negative test later in separate products
    await postSupply(a, 10, '4.00');
    await postSupply(a, 10, '5.00');
    await postSupply(b, 5, '3.00');
    await postSupply(c, 7, '2.00');

    const session = await inventories.createAndStart(actor(), {}, {});
    inventoryIds.push(session.id);

    // Block stock mutations
    await expect(
      supplies.post(
        actor(),
        (
          await supplies.create(
            actor(),
            {
              documentDate: '2026-09-14',
              items: [{ productId: a, quantity: 1, unitPurchasePrice: '1.00' }],
            },
            {},
          )
        ).id,
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_IN_PROGRESS' });

    await expect(
      products.writeOff(actor(), a, { quantity: 1, reason: 'blocked' }, {}),
    ).rejects.toMatchObject({ code: 'INVENTORY_IN_PROGRESS' });

    // Draft supply still allowed
    const draft = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        items: [{ productId: a, quantity: 1, unitPurchasePrice: '1.00' }],
      },
      {},
    );
    supplyIds.push(draft.id);
    expect(draft.status).toBe('DRAFT');

    const itemA = session.items.find((i) => i.productId === a)!;

    expect(itemA.countedQuantity).toBeNull();
    await inventories.updateItem(actor(), session.id, itemA.id, { countedQuantity: 0 }, {});
    const zeroed = await inventories.getById(actor(), session.id);
    expect(zeroed.items.find((i) => i.id === itemA.id)!.countedQuantity).toBe(0);

    await expect(inventories.complete(actor(), session.id, {})).rejects.toMatchObject({
      code: 'INVENTORY_INCOMPLETE',
    });

    await countAll(session.id, {
      [a]: 14,
      [b]: 5,
      [c]: 11,
    });

    const completed = await inventories.complete(actor(), session.id, {});
    expect(completed.status).toBe(InventoryStatus.COMPLETED);

    const stockA = await prisma.productStock.findUniqueOrThrow({ where: { productId: a } });
    const stockB = await prisma.productStock.findUniqueOrThrow({ where: { productId: b } });
    const stockC = await prisma.productStock.findUniqueOrThrow({ where: { productId: c } });
    expect(stockA.quantityOnHand).toBe(14);
    expect(stockB.quantityOnHand).toBe(5);
    expect(stockC.quantityOnHand).toBe(11);

    const movA = await prisma.stockMovement.findFirst({
      where: { productId: a, type: StockMovementType.INVENTORY_ADJUSTMENT },
      include: { allocations: true },
    });
    expect(movA?.quantity).toBe(-6);
    expect(movA?.allocations.reduce((s, x) => s + x.quantity, 0)).toBe(6);

    const lotsA = await prisma.stockLot.findMany({
      where: { productId: a, reversedAt: null },
      orderBy: { receivedAt: 'asc' },
    });
    // After -6 from first lot of 10: lot1 rem 4, lot2 rem 10
    expect(lotsA[0]!.remainingQuantity).toBe(4);
    expect(lotsA[1]!.remainingQuantity).toBe(10);

    const movB = await prisma.stockMovement.findFirst({
      where: { productId: b, type: StockMovementType.INVENTORY_ADJUSTMENT },
    });
    expect(movB).toBeNull();

    const movC = await prisma.stockMovement.findFirst({
      where: { productId: c, type: StockMovementType.INVENTORY_ADJUSTMENT },
    });
    expect(movC?.quantity).toBe(4);

    const surplus = await prisma.stockLot.findFirst({
      where: { productId: c, sourceType: StockLotSource.INVENTORY },
    });
    expect(surplus?.unitPurchasePrice).toBeNull();
    expect(surplus?.remainingQuantity).toBe(4);

    const publicC = await products.getById(actor(), c);
    expect(publicC.hasUncostedStock).toBe(true);
    expect(publicC.averagePurchaseCost).toBeNull();

    // Immutable
    await expect(
      inventories.updateItem(actor(), session.id, itemA.id, { countedQuantity: 99 }, {}),
    ).rejects.toMatchObject({ code: 'INVENTORY_NOT_EDITABLE' });
  });

  it('negative FIFO dedicated: 10@4 + 10@5 count 14', async () => {
    if (!ready) return;
    const p = await flower('Fifo');
    await postSupply(p, 10, '4.00');
    await postSupply(p, 10, '5.00');

    const session = await inventories.createAndStart(actor(), {}, {});
    inventoryIds.push(session.id);
    await countAll(session.id, { [p]: 14 });
    await inventories.complete(actor(), session.id, {});

    const lots = await prisma.stockLot.findMany({
      where: { productId: p },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });
    expect(lots[0]!.remainingQuantity).toBe(4);
    expect(lots[1]!.remainingQuantity).toBe(10);
  });

  it('counted below reserved rejected; cancel changes no stock', async () => {
    if (!ready) return;
    const p = await flower('Reserved');
    await postSupply(p, 10, '1.00');
    await prisma.productStock.update({
      where: { productId: p },
      data: { quantityReserved: 4 },
    });

    const session = await inventories.createAndStart(actor(), {}, {});
    inventoryIds.push(session.id);
    await countAll(session.id, { [p]: 3 });

    await expect(inventories.complete(actor(), session.id, {})).rejects.toMatchObject({
      code: 'INVENTORY_BELOW_RESERVED',
    });

    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId: p } });
    expect(stock.quantityOnHand).toBe(10);

    await inventories.cancel(actor(), session.id, { reason: 'abort reserved test' }, {});
    const after = await prisma.productStock.findUniqueOrThrow({ where: { productId: p } });
    expect(after.quantityOnHand).toBe(10);
  });

  it('concurrency: double start → one IN_PROGRESS', async () => {
    if (!ready) return;
    const p = await flower('DblStart');
    await postSupply(p, 1, '1.00');

    const results = await Promise.allSettled([
      inventories.createAndStart(actor(), { comment: 'a' }, {}),
      inventories.createAndStart(actor(), { comment: 'b' }, {}),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof inventories.createAndStart>>
    >[];
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    inventoryIds.push(fulfilled[0]!.value.id);

    const activeCount = await prisma.inventorySession.count({
      where: { status: InventoryStatus.IN_PROGRESS },
    });
    expect(activeCount).toBe(1);

    await inventories.cancel(
      actor(),
      fulfilled[0]!.value.id,
      { reason: 'cleanup double start' },
      {},
    );
  });

  it('concurrency: start vs supply post — one warehouse path wins safely', async () => {
    if (!ready) return;
    const p = await flower('RaceSupply');
    const draft = await supplies.create(
      actor(),
      {
        documentDate: '2026-09-14',
        items: [{ productId: p, quantity: 5, unitPurchasePrice: '2.00' }],
      },
      {},
    );
    supplyIds.push(draft.id);

    const results = await Promise.allSettled([
      inventories.createAndStart(actor(), {}, {}),
      supplies.post(actor(), draft.id, {}),
    ]);

    const invOk = results[0];
    const supplyOk = results[1];

    if (invOk.status === 'fulfilled') {
      inventoryIds.push(invOk.value.id);
      const item = invOk.value.items.find((i) => i.productId === p)!;
      // If inventory won first, expected is 0 and supply must have failed OR supply won first
      if (supplyOk.status === 'rejected') {
        expect((supplyOk.reason as AppError).code).toBe('INVENTORY_IN_PROGRESS');
        expect(item.expectedQuantity).toBe(0);
      } else {
        // Supply posted first: inventory snapshot should see 5
        expect(item.expectedQuantity).toBe(5);
      }
    } else {
      // Inventory failed — supply must have succeeded
      expect(supplyOk.status).toBe('fulfilled');
      expect((invOk.reason as AppError).code).toBeDefined();
    }

    // Never: inventory expected 0 while supply also posted unnoticed with stock 5 and inventory still in progress with stale 0 without freeze
    const active = await prisma.inventorySession.findFirst({
      where: { status: InventoryStatus.IN_PROGRESS },
      include: { items: true },
    });
    if (active) {
      inventoryIds.push(active.id);
      const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId: p } });
      const expected = active.items.find((i) => i.productId === p)?.expectedQuantity;
      expect(stock.quantityOnHand).toBe(expected);
      await inventories.cancel(actor(), active.id, { reason: 'cleanup race supply' }, {});
    }
  });

  it('concurrency: double complete applies once', async () => {
    if (!ready) return;
    const p = await flower('DblComplete');
    await postSupply(p, 8, '1.00');
    const session = await inventories.createAndStart(actor(), {}, {});
    inventoryIds.push(session.id);
    await countAll(session.id, { [p]: 6 });

    const results = await Promise.allSettled([
      inventories.complete(actor(), session.id, {}),
      inventories.complete(actor(), session.id, {}),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(1);

    const movements = await prisma.stockMovement.count({
      where: {
        productId: p,
        type: StockMovementType.INVENTORY_ADJUSTMENT,
        sourceId: session.id,
      },
    });
    expect(movements).toBe(1);
    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId: p } });
    expect(stock.quantityOnHand).toBe(6);
  });

  it('forced failure mid-complete rolls back', async () => {
    if (!ready) return;
    const p1 = await flower('Roll1');
    const p2 = await flower('Roll2');
    await postSupply(p1, 5, '1.00');
    await postSupply(p2, 5, '1.00');

    const session = await inventories.createAndStart(actor(), {}, {});
    inventoryIds.push(session.id);
    await countAll(session.id, { [p1]: 4, [p2]: 4 });

    await prisma.productStock.update({
      where: { productId: p2 },
      data: { quantityReserved: 5 },
    });

    await expect(inventories.complete(actor(), session.id, {})).rejects.toMatchObject({
      code: 'INVENTORY_BELOW_RESERVED',
    });

    const still = await prisma.inventorySession.findUniqueOrThrow({ where: { id: session.id } });
    expect(still.status).toBe(InventoryStatus.IN_PROGRESS);

    const stock1 = await prisma.productStock.findUniqueOrThrow({ where: { productId: p1 } });
    const stock2 = await prisma.productStock.findUniqueOrThrow({ where: { productId: p2 } });
    expect(stock1.quantityOnHand).toBe(5);
    expect(stock2.quantityOnHand).toBe(5);

    const mov = await prisma.stockMovement.count({
      where: { sourceId: session.id, type: StockMovementType.INVENTORY_ADJUSTMENT },
    });
    expect(mov).toBe(0);

    await inventories.cancel(actor(), session.id, { reason: 'cleanup rollback' }, {});
  });
});
