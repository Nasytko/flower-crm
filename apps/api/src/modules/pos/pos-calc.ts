import { Prisma } from '@erp/database';
import { DiscountType, PosPriceMode, ProductType } from '@erp/shared';

/**
 * Pure POS money helpers. Prisma.Decimal only — never JS floats.
 *
 * Price-mode semantics (no double charge):
 * - FLOWER components always contribute qty × salePrice to the recommended bouquet price.
 * - SERVICE components contribute only when ADDITIONAL; INCLUDED services are shown in the
 *   composition but are already covered by the bouquet price.
 * - At cart level a line with priceMode INCLUDED contributes 0; ADDITIONAL lines (root or
 *   attached child services) are charged by their own lineSubtotal.
 */

const ZERO = (): Prisma.Decimal => new Prisma.Decimal(0);

export type MoneyDecimalInput = Prisma.Decimal | string | number;

export interface PosComponentPriceInput {
  productType: ProductType | string;
  quantity: number;
  unitSalePrice: Prisma.Decimal | null | undefined;
  priceMode: PosPriceMode | string;
}

export interface PosLineAmounts {
  lineDiscountAmount: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
}

export interface PosCartTotalsLineInput {
  lineSubtotal: Prisma.Decimal;
  priceMode: PosPriceMode | string;
  parentLineId?: string | null;
}

export interface PosCartTotals {
  subtotal: Prisma.Decimal;
  discountType: DiscountType | null;
  discountValue: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

function toDecimal(value: MoneyDecimalInput): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Recommended bouquet unit price from composition:
 * sum(FLOWER qty × price) + sum(SERVICE qty × price where priceMode = ADDITIONAL).
 */
export function computeComponentRecommended(components: PosComponentPriceInput[]): Prisma.Decimal {
  let sum = ZERO();
  for (const c of components) {
    const isFlower = c.productType === ProductType.FLOWER;
    const isAdditionalService =
      c.productType === ProductType.SERVICE && c.priceMode === PosPriceMode.ADDITIONAL;
    if (!isFlower && !isAdditionalService) continue;
    if (!c.unitSalePrice) continue;
    sum = sum.plus(c.unitSalePrice.mul(c.quantity));
  }
  return sum;
}

/** Discount amount for a gross sum (clamped to [0, gross]); rounded to 2 dp. */
export function computeDiscountAmount(
  gross: Prisma.Decimal,
  discountType?: DiscountType | string | null,
  discountValue?: MoneyDecimalInput | null,
): Prisma.Decimal {
  if (!discountType || discountValue === null || discountValue === undefined) return ZERO();
  const value = toDecimal(discountValue);
  if (value.isNegative() || gross.lessThanOrEqualTo(0)) return ZERO();
  let amount: Prisma.Decimal;
  if (discountType === DiscountType.PERCENT) {
    const pct = value.greaterThan(100) ? new Prisma.Decimal(100) : value;
    amount = gross.mul(pct).div(100).toDecimalPlaces(2);
  } else {
    amount = value.toDecimalPlaces(2);
  }
  return amount.greaterThan(gross) ? gross : amount;
}

/** unit × qty minus optional line discount. lineSubtotal is never negative. */
export function computeLineSubtotal(
  unitPrice: MoneyDecimalInput,
  quantity: number,
  lineDiscountType?: DiscountType | string | null,
  lineDiscountValue?: MoneyDecimalInput | null,
): PosLineAmounts {
  const gross = toDecimal(unitPrice).mul(quantity);
  const lineDiscountAmount = computeDiscountAmount(gross, lineDiscountType, lineDiscountValue);
  const lineSubtotal = gross.minus(lineDiscountAmount);
  return {
    lineDiscountAmount,
    lineSubtotal: lineSubtotal.isNegative() ? ZERO() : lineSubtotal,
  };
}

/**
 * Cart totals. Lines with priceMode INCLUDED contribute 0 (they are covered by a parent price).
 * ADDITIONAL lines (roots and ADDITIONAL child services) are summed; then the optional
 * cart-level discount is applied on that sum. Total is never negative.
 */
export function computeCartTotals(
  lines: PosCartTotalsLineInput[],
  cartDiscountType?: DiscountType | string | null,
  cartDiscountValue?: MoneyDecimalInput | null,
): PosCartTotals {
  let subtotal = ZERO();
  for (const line of lines) {
    if (line.priceMode !== PosPriceMode.ADDITIONAL) continue;
    subtotal = subtotal.plus(line.lineSubtotal);
  }
  const hasDiscount =
    Boolean(cartDiscountType) && cartDiscountValue !== null && cartDiscountValue !== undefined;
  const discountAmount = hasDiscount
    ? computeDiscountAmount(subtotal, cartDiscountType, cartDiscountValue)
    : ZERO();
  const total = subtotal.minus(discountAmount);
  return {
    subtotal,
    discountType: hasDiscount ? (cartDiscountType as DiscountType) : null,
    discountValue: hasDiscount ? toDecimal(cartDiscountValue as MoneyDecimalInput) : null,
    discountAmount,
    total: total.isNegative() ? ZERO() : total,
  };
}
