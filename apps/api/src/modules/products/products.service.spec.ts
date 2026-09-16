import { Prisma } from '@erp/database';
import { ProductType, Role } from '@erp/shared';
import { decimalToMoneyString, toPublicProduct } from './product-mapper';
import { ProductsService } from './products.service';

describe('product-mapper', () => {
  it('serializes Decimal money as fixed 2-digit strings', () => {
    expect(decimalToMoneyString(new Prisma.Decimal('12.5'))).toBe('12.50');
    expect(decimalToMoneyString(new Prisma.Decimal(0))).toBe('0.00');
    expect(decimalToMoneyString(null)).toBeNull();
  });

  it('omits purchase fields when not permitted', () => {
    const product = toPublicProduct(
      {
        id: 'p1',
        name: 'Rose',
        sku: 'R1',
        type: ProductType.FLOWER,
        description: null,
        unit: 'PIECE',
        purchasePrice: new Prisma.Decimal('2.50'),
        salePrice: new Prisma.Decimal('5.00'),
        isActive: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        stock: { quantityOnHand: 0, quantityReserved: 0 },
        lots: [{ remainingQuantity: 10, unitPurchasePrice: new Prisma.Decimal('4.50') }],
      },
      { includePurchasePrice: false },
    );

    expect(product).not.toHaveProperty('purchasePrice');
    expect(product).not.toHaveProperty('averagePurchaseCost');
    expect(product.salePrice).toBe('5.00');
  });

  it('exposes averagePurchaseCost for FLOWER and purchasePrice for SERVICE', () => {
    const flower = toPublicProduct(
      {
        id: 'p1',
        name: 'Rose',
        sku: null,
        type: ProductType.FLOWER,
        description: null,
        unit: 'PIECE',
        purchasePrice: null,
        salePrice: new Prisma.Decimal('5.00'),
        isActive: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        stock: { quantityOnHand: 10, quantityReserved: 0 },
        lots: [
          { remainingQuantity: 5, unitPurchasePrice: new Prisma.Decimal('4.00') },
          { remainingQuantity: 5, unitPurchasePrice: new Prisma.Decimal('6.00') },
        ],
      },
      { includePurchasePrice: true },
    );
    expect(flower.averagePurchaseCost).toBe('5.00');
    expect(flower.hasUncostedStock).toBe(false);
    expect(flower).not.toHaveProperty('purchasePrice');

    const withUncosted = toPublicProduct(
      {
        id: 'p1b',
        name: 'Rose',
        sku: null,
        type: ProductType.FLOWER,
        description: null,
        unit: 'PIECE',
        purchasePrice: null,
        salePrice: new Prisma.Decimal('5.00'),
        isActive: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        stock: { quantityOnHand: 13, quantityReserved: 0 },
        lots: [
          { remainingQuantity: 10, unitPurchasePrice: new Prisma.Decimal('4.00') },
          { remainingQuantity: 3, unitPurchasePrice: null },
        ],
      },
      { includePurchasePrice: true },
    );
    expect(withUncosted.hasUncostedStock).toBe(true);
    expect(withUncosted.averagePurchaseCost).toBeNull();

    const service = toPublicProduct(
      {
        id: 'p2',
        name: 'Wrap',
        sku: null,
        type: ProductType.SERVICE,
        description: null,
        unit: 'PIECE',
        purchasePrice: new Prisma.Decimal('0.50'),
        salePrice: new Prisma.Decimal('3.00'),
        isActive: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        stock: null,
      },
      { includePurchasePrice: true },
    );
    expect(service.stock).toBeNull();
    expect(service.purchasePrice).toBe('0.50');
    expect(service).not.toHaveProperty('averagePurchaseCost');
  });
});

describe('ProductsService write-off (unit)', () => {
  const prismaMock = {
    product: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    productStock: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    stockLot: {
      update: jest.fn(),
    },
    stockMovement: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };

  const audit = { log: jest.fn() };
  const warehouseLock = { beginStockMutation: jest.fn().mockResolvedValue(undefined) };
  const stockFifo = { consumeLots: jest.fn() };
  const service = new ProductsService(
    prismaMock as never,
    audit as never,
    warehouseLock as never,
    stockFifo as never,
  );
  const actor = {
    id: 'u1',
    name: 'Director',
    login: 'director',
    role: Role.DIRECTOR,
    sessionId: 's1',
    isActive: true,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );
  });

  it('creates FLOWER with zero stock and no purchasePrice', async () => {
    const created = {
      id: 'flower-1',
      name: 'Rose',
      sku: null,
      type: ProductType.FLOWER,
      description: null,
      unit: 'PIECE',
      purchasePrice: null,
      salePrice: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      stock: { quantityOnHand: 0, quantityReserved: 0 },
      lots: [],
    };
    prismaMock.product.create.mockResolvedValue({ id: 'flower-1' });
    prismaMock.productStock.create.mockResolvedValue({});
    prismaMock.product.findUniqueOrThrow.mockResolvedValue(created);

    const result = await service.create(
      actor,
      {
        name: 'Rose',
        type: ProductType.FLOWER,
        unit: 'PIECE' as never,
        purchasePrice: '9.99',
      },
      {},
    );

    expect(prismaMock.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchasePrice: null }),
      }),
    );
    expect(result.stock?.quantityOnHand).toBe(0);
  });

  it('rejects SERVICE write-off', async () => {
    prismaMock.product.findUnique.mockResolvedValue({
      id: 'svc-1',
      type: ProductType.SERVICE,
      isActive: true,
    });

    await expect(
      service.writeOff(actor, 'svc-1', { quantity: 1, reason: 'test comment' }, {}),
    ).rejects.toMatchObject({ code: 'STOCK_NOT_SUPPORTED' });
  });

  it('applies FIFO write-off with movement and audit', async () => {
    prismaMock.product.findUnique.mockResolvedValue({
      id: 'f1',
      type: ProductType.FLOWER,
      isActive: true,
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([{ productId: 'f1' }]);
    prismaMock.productStock.findUnique.mockResolvedValue({
      productId: 'f1',
      quantityOnHand: 10,
      quantityReserved: 0,
    });
    stockFifo.consumeLots.mockResolvedValue({
      allocations: [
        {
          stockLotId: 'lot1',
          quantity: 3,
          unitPurchasePrice: new Prisma.Decimal('4.00'),
        },
      ],
      knownCost: new Prisma.Decimal('12.00'),
      hasUncosted: false,
    });
    prismaMock.productStock.update.mockResolvedValue({
      productId: 'f1',
      quantityOnHand: 7,
      quantityReserved: 0,
    });
    prismaMock.stockMovement.create.mockResolvedValue({
      id: 'm1',
      productId: 'f1',
      type: 'MANUAL_WRITE_OFF',
      quantity: -3,
      balanceAfter: 7,
      sourceType: null,
      sourceId: null,
      comment: 'spoil',
      createdByUserId: 'u1',
      createdAt: new Date('2026-01-02'),
      createdBy: { id: 'u1', name: 'Director' },
    });

    const result = await service.writeOff(
      actor,
      'f1',
      { quantity: 3, reason: 'Испорчены цветы' },
      {},
    );

    expect(result.quantityOnHand).toBe(7);
    expect(result.movement.quantity).toBe(-3);
    expect(stockFifo.consumeLots).toHaveBeenCalledWith(expect.anything(), 'f1', 3, {
      requireFullCoverage: true,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STOCK_WRITTEN_OFF' }),
    );
  });

  it('omits averagePurchaseCost for florist list responses', async () => {
    prismaMock.product.count.mockResolvedValue(1);
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'f1',
        name: 'Rose',
        sku: null,
        type: ProductType.FLOWER,
        description: null,
        unit: 'PIECE',
        purchasePrice: null,
        salePrice: new Prisma.Decimal('5.00'),
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        stock: { quantityOnHand: 1, quantityReserved: 0 },
      },
    ]);

    const florist = { ...actor, role: Role.FLORIST, login: 'florist', name: 'Florist' };
    const result = await service.list(florist, { page: 1, limit: 50 });
    expect(result.items[0]).not.toHaveProperty('averagePurchaseCost');
    expect(result.items[0]).not.toHaveProperty('purchasePrice');
  });
});
