import { Prisma } from '@erp/database';
import { ProductType, type ProductListItem, type ProductStockDto } from '@erp/shared';

export function decimalToMoneyString(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toFixed(2);
}

export function parseMoneyInput(raw: string | null | undefined): Prisma.Decimal | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const normalized = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error('INVALID_MONEY');
  }
  const value = new Prisma.Decimal(normalized);
  if (value.isNegative()) {
    throw new Error('INVALID_MONEY');
  }
  if (value.greaterThan(new Prisma.Decimal('9999999999.99'))) {
    throw new Error('INVALID_MONEY');
  }
  return value;
}

export function toStockDto(
  stock: {
    quantityOnHand: number;
    quantityReserved: number;
  } | null,
): ProductStockDto | null {
  if (!stock) {
    return null;
  }
  return {
    quantityOnHand: stock.quantityOnHand,
    quantityReserved: stock.quantityReserved,
    availableQuantity: stock.quantityOnHand - stock.quantityReserved,
  };
}

export function hasUncostedRemainingStock(
  lots: Array<{ remainingQuantity: number; unitPurchasePrice: Prisma.Decimal | null }>,
): boolean {
  return lots.some((lot) => lot.remainingQuantity > 0 && lot.unitPurchasePrice === null);
}

/**
 * Weighted average of remaining costed lots.
 * Returns null when no remaining costed quantity OR when any remaining lot is uncosted
 * (do not present a partial average as the average of all stock).
 */
export function computeAveragePurchaseCost(
  lots: Array<{ remainingQuantity: number; unitPurchasePrice: Prisma.Decimal | null }>,
): string | null {
  if (hasUncostedRemainingStock(lots)) {
    return null;
  }
  let totalQty = 0;
  let totalValue = new Prisma.Decimal(0);
  for (const lot of lots) {
    if (lot.remainingQuantity <= 0) continue;
    if (lot.unitPurchasePrice === null) continue;
    totalQty += lot.remainingQuantity;
    totalValue = totalValue.plus(lot.unitPurchasePrice.mul(lot.remainingQuantity));
  }
  if (totalQty === 0) {
    return null;
  }
  return totalValue.div(totalQty).toFixed(2);
}

export function computeMinMaxPurchaseCost(
  lots: Array<{ remainingQuantity: number; unitPurchasePrice: Prisma.Decimal | null }>,
): { min: string | null; max: string | null } {
  if (hasUncostedRemainingStock(lots)) {
    return { min: null, max: null };
  }
  let min: Prisma.Decimal | null = null;
  let max: Prisma.Decimal | null = null;
  for (const lot of lots) {
    if (lot.remainingQuantity <= 0 || lot.unitPurchasePrice === null) continue;
    if (min === null || lot.unitPurchasePrice.lessThan(min)) min = lot.unitPurchasePrice;
    if (max === null || lot.unitPurchasePrice.greaterThan(max)) max = lot.unitPurchasePrice;
  }
  return {
    min: min ? min.toFixed(2) : null,
    max: max ? max.toFixed(2) : null,
  };
}

export function toPublicProduct(
  product: {
    id: string;
    name: string;
    sku: string | null;
    type: ProductType | string;
    description: string | null;
    unit: string;
    purchasePrice: Prisma.Decimal | null;
    salePrice: Prisma.Decimal | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    stock?: { quantityOnHand: number; quantityReserved: number } | null;
    lots?: Array<{ remainingQuantity: number; unitPurchasePrice: Prisma.Decimal | null }>;
  },
  options: { includePurchasePrice: boolean; supplyCount?: number },
): ProductListItem {
  const type = product.type as ProductType;
  const base: ProductListItem = {
    id: product.id,
    name: product.name,
    sku: product.sku,
    type,
    description: product.description,
    unit: product.unit as ProductListItem['unit'],
    salePrice: decimalToMoneyString(product.salePrice),
    isActive: product.isActive,
    stock: type === ProductType.FLOWER ? toStockDto(product.stock ?? null) : null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };

  if (type === ProductType.FLOWER && options.supplyCount !== undefined) {
    base.supplyCount = options.supplyCount;
  }

  if (options.includePurchasePrice) {
    if (type === ProductType.SERVICE) {
      base.purchasePrice = decimalToMoneyString(product.purchasePrice);
    } else {
      const lots = product.lots ?? [];
      base.hasUncostedStock = hasUncostedRemainingStock(lots);
      base.averagePurchaseCost = computeAveragePurchaseCost(lots);
      const { min, max } = computeMinMaxPurchaseCost(lots);
      base.minPurchaseCost = min;
      base.maxPurchaseCost = max;
    }
  }

  return base;
}

export function formatSupplyNumber(number: number): string {
  return `П-${String(number).padStart(6, '0')}`;
}

export function multiplyMoney(unitPrice: Prisma.Decimal, quantity: number): Prisma.Decimal {
  return unitPrice.mul(quantity);
}
