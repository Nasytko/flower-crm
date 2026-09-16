import { Prisma } from '@erp/database';
import { ProductType } from '@erp/shared';
import {
  computeAvailableBouquets,
  computeEstimatedBouquetCost,
  computeMargin,
  type ProductCostSnapshot,
} from './bouquet-calc';

function snap(partial: Partial<ProductCostSnapshot> & { productId: string }): ProductCostSnapshot {
  return {
    type: ProductType.FLOWER,
    purchasePrice: null,
    isActive: true,
    availableQuantity: 0,
    lots: [],
    ...partial,
  };
}

describe('bouquet-calc', () => {
  it('availability uses available stock and ignores SERVICE', () => {
    const lines = [
      { productId: 'r', quantity: 7, productType: ProductType.FLOWER },
      { productId: 'e', quantity: 3, productType: ProductType.FLOWER },
      { productId: 'g', quantity: 2, productType: ProductType.FLOWER },
      { productId: 'p', quantity: 1, productType: ProductType.SERVICE },
    ];
    const snapshots = new Map<string, ProductCostSnapshot>([
      ['r', snap({ productId: 'r', availableQuantity: 30 })],
      ['e', snap({ productId: 'e', availableQuantity: 20 })],
      ['g', snap({ productId: 'g', availableQuantity: 8 })],
      [
        'p',
        snap({
          productId: 'p',
          type: ProductType.SERVICE,
          availableQuantity: 0,
          purchasePrice: new Prisma.Decimal('2.00'),
        }),
      ],
    ]);

    expect(computeAvailableBouquets(lines, snapshots).availableBouquets).toBe(4);

    snapshots.set('r', snap({ productId: 'r', availableQuantity: 21 })); // reserved reduced available
    expect(computeAvailableBouquets(lines, snapshots).availableBouquets).toBe(3);
  });

  it('inactive component forces availability 0', () => {
    const lines = [{ productId: 'r', quantity: 1, productType: ProductType.FLOWER }];
    const snapshots = new Map([
      ['r', snap({ productId: 'r', availableQuantity: 10, isActive: false })],
    ]);
    const result = computeAvailableBouquets(lines, snapshots);
    expect(result.availableBouquets).toBe(0);
    expect(result.hasInactiveComponents).toBe(true);
  });

  it('estimated cost and margin use Decimal-safe math', () => {
    const lines = [
      { productId: 'r', quantity: 7 },
      { productId: 'e', quantity: 3 },
      { productId: 'g', quantity: 2 },
      { productId: 'p', quantity: 1 },
    ];
    const snapshots = new Map<string, ProductCostSnapshot>([
      [
        'r',
        snap({
          productId: 'r',
          availableQuantity: 30,
          lots: [{ remainingQuantity: 30, unitPurchasePrice: new Prisma.Decimal('5.20') }],
        }),
      ],
      [
        'e',
        snap({
          productId: 'e',
          availableQuantity: 20,
          lots: [{ remainingQuantity: 20, unitPurchasePrice: new Prisma.Decimal('3.00') }],
        }),
      ],
      [
        'g',
        snap({
          productId: 'g',
          availableQuantity: 8,
          lots: [{ remainingQuantity: 8, unitPurchasePrice: new Prisma.Decimal('1.50') }],
        }),
      ],
      [
        'p',
        snap({
          productId: 'p',
          type: ProductType.SERVICE,
          purchasePrice: new Prisma.Decimal('2.00'),
        }),
      ],
    ]);

    const { estimatedCurrentCost, hasUnknownCost } = computeEstimatedBouquetCost(lines, snapshots);
    expect(hasUnknownCost).toBe(false);
    expect(estimatedCurrentCost!.toFixed(2)).toBe('50.40');

    const { margin, marginPercent } = computeMargin(
      new Prisma.Decimal('80.00'),
      estimatedCurrentCost,
    );
    expect(margin).toBe('29.60');
    expect(marginPercent).toBe('37.00');
  });

  it('uncosted flower lot makes estimated cost unavailable', () => {
    const lines = [{ productId: 'r', quantity: 1 }];
    const snapshots = new Map([
      [
        'r',
        snap({
          productId: 'r',
          availableQuantity: 5,
          lots: [
            { remainingQuantity: 2, unitPurchasePrice: new Prisma.Decimal('4.00') },
            { remainingQuantity: 3, unitPurchasePrice: null },
          ],
        }),
      ],
    ]);
    const result = computeEstimatedBouquetCost(lines, snapshots);
    expect(result.hasUnknownCost).toBe(true);
    expect(result.estimatedCurrentCost).toBeNull();
  });

  it('null SERVICE purchasePrice makes cost unavailable', () => {
    const lines = [
      { productId: 'r', quantity: 1 },
      { productId: 'p', quantity: 1 },
    ];
    const snapshots = new Map<string, ProductCostSnapshot>([
      [
        'r',
        snap({
          productId: 'r',
          availableQuantity: 5,
          lots: [{ remainingQuantity: 5, unitPurchasePrice: new Prisma.Decimal('1.00') }],
        }),
      ],
      [
        'p',
        snap({
          productId: 'p',
          type: ProductType.SERVICE,
          purchasePrice: null,
        }),
      ],
    ]);
    const result = computeEstimatedBouquetCost(lines, snapshots);
    expect(result.hasUnknownCost).toBe(true);
    expect(result.estimatedCurrentCost).toBeNull();
  });
});
