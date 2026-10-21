import { Prisma } from '@erp/database';
import { DiscountType, PosPriceMode, ProductType } from '@erp/shared';
import { computeCartTotals, computeComponentRecommended, computeLineSubtotal } from './pos-calc';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('computeComponentRecommended', () => {
  it('sums FLOWER qty × price', () => {
    const r = computeComponentRecommended([
      {
        productType: ProductType.FLOWER,
        quantity: 5,
        unitSalePrice: D('3.50'),
        priceMode: PosPriceMode.ADDITIONAL,
      },
      {
        productType: ProductType.FLOWER,
        quantity: 2,
        unitSalePrice: D('10.00'),
        priceMode: PosPriceMode.ADDITIONAL,
      },
    ]);
    expect(r.toFixed(2)).toBe('37.50');
  });

  it('INCLUDED service is excluded, ADDITIONAL service is added', () => {
    const base = {
      productType: ProductType.FLOWER,
      quantity: 3,
      unitSalePrice: D('10.00'),
      priceMode: PosPriceMode.ADDITIONAL,
    };
    const included = computeComponentRecommended([
      base,
      {
        productType: ProductType.SERVICE,
        quantity: 1,
        unitSalePrice: D('5.00'),
        priceMode: PosPriceMode.INCLUDED,
      },
    ]);
    const additional = computeComponentRecommended([
      base,
      {
        productType: ProductType.SERVICE,
        quantity: 1,
        unitSalePrice: D('5.00'),
        priceMode: PosPriceMode.ADDITIONAL,
      },
    ]);
    expect(included.toFixed(2)).toBe('30.00');
    expect(additional.toFixed(2)).toBe('35.00');
  });

  it('FLOWER always counts even if priceMode is INCLUDED; null price counts as 0', () => {
    const r = computeComponentRecommended([
      {
        productType: ProductType.FLOWER,
        quantity: 2,
        unitSalePrice: D('4.00'),
        priceMode: PosPriceMode.INCLUDED,
      },
      {
        productType: ProductType.FLOWER,
        quantity: 9,
        unitSalePrice: null,
        priceMode: PosPriceMode.ADDITIONAL,
      },
    ]);
    expect(r.toFixed(2)).toBe('8.00');
  });

  it('is decimal-safe (no float drift)', () => {
    const r = computeComponentRecommended([
      {
        productType: ProductType.FLOWER,
        quantity: 3,
        unitSalePrice: D('0.10'),
        priceMode: PosPriceMode.ADDITIONAL,
      },
    ]);
    expect(r.toFixed(2)).toBe('0.30');
  });

  it('empty composition is zero', () => {
    expect(computeComponentRecommended([]).toFixed(2)).toBe('0.00');
  });
});

describe('computeLineSubtotal', () => {
  it('no discount', () => {
    const r = computeLineSubtotal(D('12.50'), 3);
    expect(r.lineDiscountAmount.toFixed(2)).toBe('0.00');
    expect(r.lineSubtotal.toFixed(2)).toBe('37.50');
  });

  it('percent discount rounds to 2 dp', () => {
    const r = computeLineSubtotal(D('33.33'), 1, DiscountType.PERCENT, D('10'));
    expect(r.lineDiscountAmount.toFixed(2)).toBe('3.33');
    expect(r.lineSubtotal.toFixed(2)).toBe('30.00');
  });

  it('fixed discount', () => {
    const r = computeLineSubtotal(D('20.00'), 2, DiscountType.FIXED, D('5.00'));
    expect(r.lineSubtotal.toFixed(2)).toBe('35.00');
  });

  it('fixed discount larger than gross clamps to zero subtotal', () => {
    const r = computeLineSubtotal(D('10.00'), 1, DiscountType.FIXED, D('50.00'));
    expect(r.lineDiscountAmount.toFixed(2)).toBe('10.00');
    expect(r.lineSubtotal.toFixed(2)).toBe('0.00');
  });

  it('missing discount value ignores discount type', () => {
    const r = computeLineSubtotal(D('10.00'), 1, DiscountType.PERCENT, null);
    expect(r.lineSubtotal.toFixed(2)).toBe('10.00');
  });
});

describe('computeCartTotals', () => {
  it('sums multiple ADDITIONAL lines', () => {
    const t = computeCartTotals([
      { lineSubtotal: D('100.00'), priceMode: PosPriceMode.ADDITIONAL },
      { lineSubtotal: D('50.50'), priceMode: PosPriceMode.ADDITIONAL },
    ]);
    expect(t.subtotal.toFixed(2)).toBe('150.50');
    expect(t.discountAmount.toFixed(2)).toBe('0.00');
    expect(t.total.toFixed(2)).toBe('150.50');
  });

  it('does not double charge: INCLUDED child service adds nothing on top of the bouquet', () => {
    const t = computeCartTotals([
      { lineSubtotal: D('80.00'), priceMode: PosPriceMode.ADDITIONAL },
      {
        lineSubtotal: D('0.00'),
        priceMode: PosPriceMode.INCLUDED,
        parentLineId: 'bouquet-1',
      },
      {
        // even if a non-zero subtotal sneaks in, INCLUDED must be skipped
        lineSubtotal: D('7.00'),
        priceMode: PosPriceMode.INCLUDED,
        parentLineId: 'bouquet-1',
      },
    ]);
    expect(t.subtotal.toFixed(2)).toBe('80.00');
  });

  it('ADDITIONAL child service is charged once', () => {
    const t = computeCartTotals([
      { lineSubtotal: D('80.00'), priceMode: PosPriceMode.ADDITIONAL },
      { lineSubtotal: D('5.00'), priceMode: PosPriceMode.ADDITIONAL, parentLineId: 'b' },
    ]);
    expect(t.subtotal.toFixed(2)).toBe('85.00');
  });

  it('applies percent cart discount on the sum of line subtotals', () => {
    const t = computeCartTotals(
      [
        { lineSubtotal: D('100.00'), priceMode: PosPriceMode.ADDITIONAL },
        { lineSubtotal: D('100.00'), priceMode: PosPriceMode.ADDITIONAL },
        { lineSubtotal: D('0.00'), priceMode: PosPriceMode.INCLUDED, parentLineId: 'x' },
      ],
      DiscountType.PERCENT,
      D('10'),
    );
    expect(t.subtotal.toFixed(2)).toBe('200.00');
    expect(t.discountAmount.toFixed(2)).toBe('20.00');
    expect(t.total.toFixed(2)).toBe('180.00');
    expect(t.discountType).toBe(DiscountType.PERCENT);
  });

  it('applies fixed cart discount', () => {
    const t = computeCartTotals(
      [{ lineSubtotal: D('60.00'), priceMode: PosPriceMode.ADDITIONAL }],
      DiscountType.FIXED,
      D('15.00'),
    );
    expect(t.total.toFixed(2)).toBe('45.00');
  });

  it('never returns a negative total (fixed discount > subtotal)', () => {
    const t = computeCartTotals(
      [{ lineSubtotal: D('10.00'), priceMode: PosPriceMode.ADDITIONAL }],
      DiscountType.FIXED,
      D('999.00'),
    );
    expect(t.discountAmount.toFixed(2)).toBe('10.00');
    expect(t.total.toFixed(2)).toBe('0.00');
  });

  it('empty cart is zero', () => {
    const t = computeCartTotals([], DiscountType.PERCENT, D('10'));
    expect(t.subtotal.toFixed(2)).toBe('0.00');
    expect(t.total.toFixed(2)).toBe('0.00');
  });

  it('template bouquet with INCLUDED service: recommended + totals charge once', () => {
    const recommended = computeComponentRecommended([
      {
        productType: ProductType.FLOWER,
        quantity: 7,
        unitSalePrice: D('10.00'),
        priceMode: PosPriceMode.ADDITIONAL,
      },
      {
        productType: ProductType.SERVICE,
        quantity: 1,
        unitSalePrice: D('15.00'),
        priceMode: PosPriceMode.INCLUDED,
      },
    ]);
    const line = computeLineSubtotal(recommended, 1);
    const t = computeCartTotals([
      { lineSubtotal: line.lineSubtotal, priceMode: PosPriceMode.ADDITIONAL },
    ]);
    expect(t.total.toFixed(2)).toBe('70.00');
  });
});
