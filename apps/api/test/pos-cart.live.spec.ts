import {
  AssembledBouquetStatus,
  DiscountType,
  FulfillmentType,
  OrderFulfillmentMode,
  OrderItemType,
  OrderPaymentStatus,
  OrderSource,
  PosCartLineType,
  PosCartStatus,
  PosPriceMode,
  ProductType,
  Role,
  Unit,
} from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { AuditService } from '../src/modules/audit/audit.service';
import { AppConfigService } from '../src/config/app-config.service';
import { ProductsService } from '../src/modules/products/products.service';
import { SuppliesService } from '../src/modules/supplies/supplies.service';
import { WarehouseLockService } from '../src/modules/warehouse/warehouse-lock.service';
import { StockFifoService } from '../src/modules/warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../src/modules/warehouse/reservation-allocation.service';
import { StockBalanceService } from '../src/modules/warehouse/stock-balance.service';
import { AssembledBouquetService } from '../src/modules/warehouse/assembled-bouquet.service';
import { PosCartService } from '../src/modules/pos/pos-cart.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { hashPassword } from '../src/common/security/password';
import {
  cancelLeftoverInventories,
  createTestSupplier,
  deleteTestSuppliers,
} from './helpers/live-db';
import { AppError } from '../src/common/errors/app-error';

/**
 * POS stage 1: working carts never touch the warehouse; confirm creates an Order (UNPAID).
 * Live Postgres only (skipped without DATABASE_URL / reachable DB).
 */
describe('POS cart (live DB)', () => {
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
  const pos = new PosCartService(
    prisma as never,
    audit,
    config,
    warehouseLock,
    reservationAllocation,
    assembled,
  );
  const suffix = Date.now().toString(36);

  let directorId = '';
  let floristId = '';
  let supplierId = '';
  let ready = false;
  const productIds: string[] = [];
  const supplyIds: string[] = [];
  const bouquetTemplateIds: string[] = [];
  const assembledIds: string[] = [];
  const cartIds: string[] = [];
  const orderIds: string[] = [];

  const director = () => ({
    id: directorId,
    name: 'Pos Director',
    login: `pos_d_${suffix}`,
    role: Role.DIRECTOR,
    sessionId: 'live-pos',
    isActive: true,
  });
  const florist = () => ({
    id: floristId,
    name: 'Pos Florist',
    login: `pos_f_${suffix}`,
    role: Role.FLORIST,
    sessionId: 'live-pos-f',
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
      data: { login: `pos_d_${suffix}`, name: 'Pos Director', role: Role.DIRECTOR, passwordHash },
    });
    directorId = d.id;
    const f = await prisma.user.create({
      data: { login: `pos_f_${suffix}`, name: 'Pos Florist', role: Role.FLORIST, passwordHash },
    });
    floristId = f.id;
    const supplier = await createTestSupplier(prisma, `POS Live ${suffix}`);
    supplierId = supplier.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      if (cartIds.length) {
        await prisma.posCart.deleteMany({ where: { id: { in: cartIds } } });
      }
      if (assembledIds.length) {
        await prisma.assembledBouquetComponentLot.deleteMany({
          where: { component: { assembledBouquetId: { in: assembledIds } } },
        });
        await prisma.assembledBouquetComponent.deleteMany({
          where: { assembledBouquetId: { in: assembledIds } },
        });
        await prisma.assembledBouquet.deleteMany({ where: { id: { in: assembledIds } } });
      }
      if (orderIds.length) {
        await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItemComponent.deleteMany({
          where: { orderItem: { orderId: { in: orderIds } } },
        });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      if (bouquetTemplateIds.length) {
        await prisma.bouquetItem.deleteMany({ where: { bouquetId: { in: bouquetTemplateIds } } });
        await prisma.bouquet.deleteMany({ where: { id: { in: bouquetTemplateIds } } });
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
      const userIds = [directorId, floristId].filter(Boolean);
      if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  // --- helpers ---------------------------------------------------------------

  async function product(name: string, type: ProductType, salePrice: string): Promise<string> {
    const p = await products.create(director(), { name, type, unit: Unit.PIECE, salePrice }, {});
    productIds.push(p.id);
    return p.id;
  }

  async function flowerWithStock(name: string, qty = 100, price = '10.00'): Promise<string> {
    const id = await product(`${name} ${suffix}`, ProductType.FLOWER, price);
    const draft = await supplies.create(
      director(),
      {
        documentDate: orders.businessTime().businessDate,
        supplierId,
        items: [{ productId: id, quantity: qty, unitPurchasePrice: '2.00' }],
      },
      {},
    );
    supplyIds.push(draft.id);
    await supplies.post(director(), draft.id, {});
    return id;
  }

  async function template(
    name: string,
    salePrice: string,
    items: Array<{ productId: string; quantity: number }>,
  ): Promise<string> {
    const b = await prisma.bouquet.create({
      data: {
        name: `${name} ${suffix}`,
        salePrice,
        items: { create: items },
      },
    });
    bouquetTemplateIds.push(b.id);
    return b.id;
  }

  async function newCart(actor = director()) {
    const cart = await pos.createCart(actor);
    cartIds.push(cart.id);
    return cart;
  }

  function shift(iso: string, days: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toMatchObject({ code });
    await promise.catch((e) => expect(e).toBeInstanceOf(AppError));
  }

  const confirmWalkIn = (cartId: string, version: number, key: string, actor = director()) =>
    pos.confirm(
      actor,
      cartId,
      {
        expectedVersion: version,
        idempotencyKey: key,
        fulfillmentMode: OrderFulfillmentMode.WALK_IN,
      },
      {},
    );

  // --- tests -----------------------------------------------------------------

  it('cart add / edit does not change ProductStock, movements or reservations', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosStock');
    const tplId = await template('PosStockTpl', '50.00', [{ productId: flowerId, quantity: 5 }]);
    const before = await prisma.productStock.findUniqueOrThrow({ where: { productId: flowerId } });
    const movementsBefore = await prisma.stockMovement.count({ where: { productId: flowerId } });
    const reservationsBefore = await prisma.stockReservation.count({
      where: { productId: flowerId },
    });

    let cart = await newCart();
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.PRODUCT,
      productId: flowerId,
      quantity: 10,
    });
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.BOUQUET_TEMPLATE,
      bouquetTemplateId: tplId,
      copies: 3,
    });
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.BOUQUET_CUSTOM,
      components: [{ productId: flowerId, quantity: 7 }],
    });
    expect(cart.lines).toHaveLength(5); // 1 product + 3 independent template lines + 1 custom
    const templateLines = cart.lines.filter((l) => l.lineType === PosCartLineType.BOUQUET_TEMPLATE);
    expect(templateLines).toHaveLength(3);
    expect(new Set(templateLines.map((l) => l.id)).size).toBe(3);
    expect(templateLines.every((l) => l.quantity === 1)).toBe(true);
    // 10×10 + 3×50 + 7×10
    expect(cart.total).toBe('320.00');

    const first = cart.lines[0]!;
    cart = await pos.updateLine(director(), cart.id, first.id, {
      expectedVersion: cart.version,
      quantity: 2,
    });
    cart = await pos.removeLine(director(), cart.id, first.id, cart.version);
    expect(cart.lines).toHaveLength(4);

    const after = await prisma.productStock.findUniqueOrThrow({ where: { productId: flowerId } });
    expect(after.quantityOnHand).toBe(before.quantityOnHand);
    expect(after.quantityReserved).toBe(before.quantityReserved);
    expect(after.quantityInBouquets).toBe(before.quantityInBouquets);
    expect(await prisma.stockMovement.count({ where: { productId: flowerId } })).toBe(
      movementsBefore,
    );
    expect(await prisma.stockReservation.count({ where: { productId: flowerId } })).toBe(
      reservationsBefore,
    );
  });

  it('confirm is idempotent for the same key and creates a POS UNPAID WALK_IN order', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosIdem');
    const serviceId = await product(`PosIdemSvc ${suffix}`, ProductType.SERVICE, '5.00');
    const tplId = await template('PosIdemTpl', '70.00', [
      { productId: flowerId, quantity: 5 },
      { productId: serviceId, quantity: 1 },
    ]);

    let cart = await newCart();
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.BOUQUET_TEMPLATE,
      bouquetTemplateId: tplId,
    });
    const line = cart.lines[0]!;
    // Template SERVICE is INCLUDED by default → template salePrice authoritative, no double charge.
    expect(line.unitPrice).toBe('70.00');
    expect(line.recommendedUnitPrice).toBe('70.00');
    expect(line.components.find((c) => c.productId === serviceId)?.priceMode).toBe(
      PosPriceMode.INCLUDED,
    );
    expect(cart.total).toBe('70.00');

    const key = `idem-${suffix}-1`;
    const first = await confirmWalkIn(cart.id, cart.version, key);
    orderIds.push(first.orderId);
    const second = await confirmWalkIn(cart.id, cart.version, key);
    expect(second.orderId).toBe(first.orderId);
    expect(second.orderNumber).toBe(first.orderNumber);
    expect(second.cart.status).toBe(PosCartStatus.CONFIRMED);
    expect(await prisma.order.count({ where: { idempotencyKey: key } })).toBe(1);

    await expectCode(
      confirmWalkIn(cart.id, cart.version, `idem-${suffix}-other`),
      'POS_CART_ALREADY_CONFIRMED',
    );
    // Confirmed carts are immutable.
    await expectCode(
      pos.addLine(director(), cart.id, {
        lineType: PosCartLineType.PRODUCT,
        productId: flowerId,
      }),
      'POS_CART_NOT_EDITABLE',
    );

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: first.orderId },
      include: { items: { include: { components: true } }, reservations: true },
    });
    expect(order.source).toBe(OrderSource.POS);
    expect(order.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
    expect(order.fulfillmentMode).toBe(OrderFulfillmentMode.WALK_IN);
    expect(order.fulfillmentType).toBe(FulfillmentType.PICKUP);
    expect(order.customerPhone).toBe('');
    expect(order.total.toFixed(2)).toBe('70.00');
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.bouquetId).toBe(tplId);
    expect(order.items[0]!.components).toHaveLength(2);
    // WALK_IN also creates planned reserve for unassembled FLOWER (same engine as SCHEDULED).
    expect(order.reservations).toHaveLength(1);
    expect(order.reservations[0]!.productId).toBe(flowerId);
    expect(order.reservations[0]!.requiredQuantity).toBe(5);
    expect(order.reservations[0]!.reservedQuantity).toBe(5);

    // Order detail mapper exposes the new fields.
    const detail = await orders.getById(director(), first.orderId);
    expect(detail.source).toBe(OrderSource.POS);
    expect(detail.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
    expect(detail.items[0]!.priceMode).toBe(PosPriceMode.ADDITIONAL);
  });

  it('two concurrent confirms of the same assembled bouquet → exactly one wins', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosAsm', 50);
    const ab = await assembled.assemble(
      director(),
      {
        nameSnapshot: `Vitrine ${suffix}`,
        components: [{ productId: flowerId, quantity: 3 }],
        idempotencyKey: `pos-asm-${suffix}`,
      },
      {},
    );
    assembledIds.push(ab.id);
    expect(ab.status).toBe(AssembledBouquetStatus.ASSEMBLED);

    const cartA = await pos.addLine(director(), (await newCart()).id, {
      lineType: PosCartLineType.ASSEMBLED,
      assembledBouquetId: ab.id,
    });
    expect(cartA.lines[0]!.components).toHaveLength(1);

    // Soft conflict: a second cart cannot take the same bouquet through the API…
    const cartBEmpty = await newCart();
    await expectCode(
      pos.addLine(director(), cartBEmpty.id, {
        lineType: PosCartLineType.ASSEMBLED,
        assembledBouquetId: ab.id,
      }),
      'POS_ASSEMBLED_IN_CART',
    );

    // …so force the race by inserting the line directly (hard gate is confirm).
    await prisma.posCartLine.create({
      data: {
        cartId: cartBEmpty.id,
        lineType: PosCartLineType.ASSEMBLED,
        assembledBouquetId: ab.id,
        nameSnapshot: ab.nameSnapshot,
        quantity: 1,
        recommendedUnitPrice: '30.00',
        unitPrice: '30.00',
        lineSubtotal: '30.00',
      },
    });

    const results = await Promise.allSettled([
      confirmWalkIn(cartA.id, cartA.version, `race-a-${suffix}`),
      confirmWalkIn(cartBEmpty.id, cartBEmpty.version, `race-b-${suffix}`),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ orderId: string }>).value;
    orderIds.push(winner.orderId);
    const loserErr = (lost[0] as PromiseRejectedResult).reason as AppError;
    expect(loserErr.code).toBe('POS_ASSEMBLED_UNAVAILABLE');

    const row = await prisma.assembledBouquet.findUniqueOrThrow({ where: { id: ab.id } });
    expect(row.orderId).toBe(winner.orderId);
    expect(row.orderItemId).not.toBeNull();
    expect(row.version).toBe(ab.version + 1);
    const winnerOrder = await prisma.order.findUniqueOrThrow({ where: { id: winner.orderId } });
    expect(winnerOrder.source).toBe(OrderSource.POS);
  });

  it('custom bouquet order has bouquetId null and component snapshot', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosCustom', 100, '12.00');
    const serviceId = await product(`PosCustomSvc ${suffix}`, ProductType.SERVICE, '5.00');

    // Custom bouquet requires at least one FLOWER.
    const emptyCart = await newCart();
    await expectCode(
      pos.addLine(director(), emptyCart.id, {
        lineType: PosCartLineType.BOUQUET_CUSTOM,
        components: [{ productId: serviceId, quantity: 1 }],
      }),
      'POS_COMPOSITION_REQUIRES_FLOWER',
    );

    let cart = await pos.addLine(director(), emptyCart.id, {
      lineType: PosCartLineType.BOUQUET_CUSTOM,
      nameSnapshot: 'Custom A',
      components: [
        { productId: flowerId, quantity: 3 },
        { productId: serviceId, quantity: 1, priceMode: PosPriceMode.ADDITIONAL },
      ],
    });
    expect(cart.lines[0]!.recommendedUnitPrice).toBe('41.00'); // 3×12 + 5
    expect(cart.total).toBe('41.00');

    const confirmed = await confirmWalkIn(cart.id, cart.version, `custom-${suffix}`);
    orderIds.push(confirmed.orderId);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: confirmed.orderId },
      include: { components: true },
    });
    expect(item.itemType).toBe(OrderItemType.BOUQUET);
    expect(item.bouquetId).toBeNull();
    expect(item.nameSnapshot).toBe('Custom A');
    expect(item.components).toHaveLength(2);
    const flowerComp = item.components.find((c) => c.productId === flowerId)!;
    expect(flowerComp.quantityPerItem).toBe(3);
    expect(flowerComp.totalQuantity).toBe(3);
    expect(flowerComp.unitSalePriceSnapshot?.toFixed(2)).toBe('12.00');
    cart = await pos.getCart(director(), cart.id);
    expect(cart.status).toBe(PosCartStatus.CONFIRMED);
  });

  it('SCHEDULED confirm creates a FLOWER StockReservation (and requires phone + date)', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosSched', 40);
    const tplId = await template('PosSchedTpl', '60.00', [{ productId: flowerId, quantity: 5 }]);
    const tomorrow = shift(orders.businessTime().businessDate, 1);

    const cart = await pos.addLine(director(), (await newCart()).id, {
      lineType: PosCartLineType.BOUQUET_TEMPLATE,
      bouquetTemplateId: tplId,
    });

    await expectCode(
      pos.confirm(
        director(),
        cart.id,
        {
          expectedVersion: cart.version,
          idempotencyKey: `sched-nophone-${suffix}`,
          fulfillmentMode: OrderFulfillmentMode.SCHEDULED,
          fulfillmentDate: tomorrow,
        },
        {},
      ),
      'POS_PHONE_REQUIRED',
    );

    const confirmed = await pos.confirm(
      director(),
      cart.id,
      {
        expectedVersion: cart.version,
        idempotencyKey: `sched-${suffix}`,
        fulfillmentMode: OrderFulfillmentMode.SCHEDULED,
        customerPhone: '+375291112233',
        customerName: 'Sched',
        fulfillmentType: FulfillmentType.PICKUP,
        fulfillmentDate: tomorrow,
        fulfillmentTimeFrom: '12:00',
      },
      {},
    );
    orderIds.push(confirmed.orderId);

    const reservation = await prisma.stockReservation.findUniqueOrThrow({
      where: { orderId_productId: { orderId: confirmed.orderId, productId: flowerId } },
    });
    expect(reservation.requiredQuantity).toBe(5);
    expect(reservation.reservedQuantity).toBe(5);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: confirmed.orderId } });
    expect(order.fulfillmentMode).toBe(OrderFulfillmentMode.SCHEDULED);
    expect(order.customerPhone).toBe('+375291112233');
    expect(order.fulfillmentDate.toISOString().slice(0, 10)).toBe(tomorrow);
    const stock = await prisma.productStock.findUniqueOrThrow({ where: { productId: flowerId } });
    expect(stock.quantityOnHand).toBe(40);
    expect(stock.quantityReserved).toBe(5);
  });

  it('SERVICE lines create no stock movements on confirm', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosSvcFlower');
    const serviceId = await product(`PosSvc ${suffix}`, ProductType.SERVICE, '8.00');

    let cart = await newCart();
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.SERVICE,
      productId: serviceId,
      quantity: 2,
    });
    expect(cart.total).toBe('16.00');
    // ADDITIONAL child service attached to a flower line is charged once.
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.PRODUCT,
      productId: flowerId,
      quantity: 2,
    });
    const flowerLine = cart.lines.find((l) => l.lineType === PosCartLineType.PRODUCT)!;
    cart = await pos.addLine(director(), cart.id, {
      lineType: PosCartLineType.SERVICE,
      productId: serviceId,
      parentLineId: flowerLine.id,
    });
    expect(cart.lines).toHaveLength(2);
    expect(cart.lines.find((l) => l.id === flowerLine.id)!.childLines).toHaveLength(1);
    expect(cart.total).toBe('44.00'); // 16 + 2×10 + 8

    const movementsBefore = await prisma.stockMovement.count({
      where: { productId: { in: [serviceId, flowerId] } },
    });
    const confirmed = await confirmWalkIn(cart.id, cart.version, `svc-${suffix}`);
    orderIds.push(confirmed.orderId);
    expect(
      await prisma.stockMovement.count({ where: { productId: { in: [serviceId, flowerId] } } }),
    ).toBe(movementsBefore);

    const items = await prisma.orderItem.findMany({
      where: { orderId: confirmed.orderId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(items).toHaveLength(3);
    const childItem = items.find((i) => i.parentOrderItemId !== null)!;
    const parentItem = items.find((i) => i.productId === flowerId)!;
    expect(childItem.parentOrderItemId).toBe(parentItem.id);
    expect(childItem.productId).toBe(serviceId);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: confirmed.orderId } });
    expect(order.total.toFixed(2)).toBe('44.00');
  });

  it('price override / discount permissions, recommended recalc keeps overridden price', async () => {
    if (!ready) return;
    const flowerId = await flowerWithStock('PosPrice', 100, '10.00');
    const tplId = await template('PosPriceTpl', '50.00', [{ productId: flowerId, quantity: 5 }]);

    // FLORIST: POS_ACCESS + POS_SELL only.
    const fCart = await newCart(florist());
    await expectCode(
      pos.addLine(florist(), fCart.id, {
        lineType: PosCartLineType.BOUQUET_TEMPLATE,
        bouquetTemplateId: tplId,
        unitPrice: '40.00',
      }),
      'FORBIDDEN',
    );
    const fCart2 = await pos.addLine(florist(), fCart.id, {
      lineType: PosCartLineType.BOUQUET_TEMPLATE,
      bouquetTemplateId: tplId,
    });
    await expectCode(
      pos.updateDiscount(florist(), fCart.id, {
        expectedVersion: fCart2.version,
        discountType: DiscountType.PERCENT,
        discountValue: '10',
      }),
      'FORBIDDEN',
    );
    // Other users cannot touch someone else's cart.
    await expectCode(pos.getCart(director(), fCart.id), 'FORBIDDEN');

    // DIRECTOR overrides price on a template line.
    let cart = await pos.addLine(director(), (await newCart()).id, {
      lineType: PosCartLineType.BOUQUET_TEMPLATE,
      bouquetTemplateId: tplId,
      unitPrice: '60.00',
    });
    let line = cart.lines[0]!;
    expect(line.priceOverridden).toBe(true);
    expect(line.unitPrice).toBe('60.00');
    expect(line.recommendedUnitPrice).toBe('50.00');

    // Stale version is rejected (CAS).
    await expectCode(
      pos.updateLine(director(), cart.id, line.id, {
        expectedVersion: cart.version - 1,
        nameSnapshot: 'x',
      }),
      'POS_CART_CONFLICT',
    );

    // Composition edit recalculates recommended but keeps the overridden unit price.
    cart = await pos.updateLine(director(), cart.id, line.id, {
      expectedVersion: cart.version,
      components: [{ productId: flowerId, quantity: 2 }],
    });
    line = cart.lines[0]!;
    expect(line.recommendedUnitPrice).toBe('20.00');
    expect(line.unitPrice).toBe('60.00');
    expect(line.priceOverridden).toBe(true);

    cart = await pos.updateLine(director(), cart.id, line.id, {
      expectedVersion: cart.version,
      acceptRecommendedPrice: true,
    });
    line = cart.lines[0]!;
    expect(line.unitPrice).toBe('20.00');
    expect(line.priceOverridden).toBe(false);

    // Line + cart discounts (director has orders.discount).
    cart = await pos.updateLine(director(), cart.id, line.id, {
      expectedVersion: cart.version,
      lineDiscountType: DiscountType.FIXED,
      lineDiscountValue: '5.00',
    });
    expect(cart.lines[0]!.lineSubtotal).toBe('15.00');
    cart = await pos.updateDiscount(director(), cart.id, {
      expectedVersion: cart.version,
      discountType: DiscountType.PERCENT,
      discountValue: '10',
    });
    expect(cart.subtotal).toBe('15.00');
    expect(cart.discountAmount).toBe('1.50');
    expect(cart.total).toBe('13.50');

    // Park / resume round-trip.
    cart = await pos.park(director(), cart.id, {
      expectedVersion: cart.version,
      parkedLabel: 'later',
    });
    expect(cart.status).toBe(PosCartStatus.PARKED);
    expect(
      (await pos.listCarts(director(), PosCartStatus.PARKED)).some((c) => c.id === cart.id),
    ).toBe(true);
    cart = await pos.resume(director(), cart.id, cart.version);
    expect(cart.status).toBe(PosCartStatus.OPEN);
  });
});
