import { Prisma } from '@erp/database';
import {
  ProductType,
  Unit,
  type BouquetItemDto,
  type BouquetListItem,
  type MoneyString,
} from '@erp/shared';
import {
  computeAveragePurchaseCost,
  decimalToMoneyString,
  hasUncostedRemainingStock,
} from '../products/product-mapper';

export type ProductCostSnapshot = {
  productId: string;
  type: ProductType | string;
  purchasePrice: Prisma.Decimal | null;
  isActive: boolean;
  availableQuantity: number;
  lots: Array<{ remainingQuantity: number; unitPurchasePrice: Prisma.Decimal | null }>;
};

export type RecipeLine = {
  productId: string;
  quantity: number;
  product: {
    id: string;
    name: string;
    sku: string | null;
    type: ProductType | string;
    unit: string;
    isActive: boolean;
  };
};

/** Unit cost for one product, or null if unknown / unavailable. */
export function resolveComponentUnitCost(snapshot: ProductCostSnapshot): Prisma.Decimal | null {
  if (snapshot.type === ProductType.SERVICE) {
    return snapshot.purchasePrice;
  }
  if (hasUncostedRemainingStock(snapshot.lots)) {
    return null;
  }
  const avg = computeAveragePurchaseCost(snapshot.lots);
  if (avg === null) {
    return null;
  }
  return new Prisma.Decimal(avg);
}

export function computeAvailableBouquets(
  lines: Array<{ productId: string; quantity: number; productType: ProductType | string }>,
  snapshots: Map<string, ProductCostSnapshot>,
): { availableBouquets: number; hasInactiveComponents: boolean } {
  let hasInactiveComponents = false;
  let minCapacity = Number.POSITIVE_INFINITY;
  let flowerCount = 0;

  for (const line of lines) {
    const snap = snapshots.get(line.productId);
    if (!snap || !snap.isActive) {
      hasInactiveComponents = true;
    }
    if (line.productType !== ProductType.FLOWER) {
      continue;
    }
    flowerCount += 1;
    if (!snap || !snap.isActive) {
      minCapacity = 0;
      continue;
    }
    const capacity = Math.floor(snap.availableQuantity / line.quantity);
    minCapacity = Math.min(minCapacity, capacity);
  }

  if (flowerCount === 0) {
    return { availableBouquets: 0, hasInactiveComponents };
  }
  if (hasInactiveComponents) {
    return { availableBouquets: 0, hasInactiveComponents };
  }
  return {
    availableBouquets: Number.isFinite(minCapacity) ? Math.max(0, minCapacity) : 0,
    hasInactiveComponents,
  };
}

export function computeEstimatedBouquetCost(
  lines: Array<{ productId: string; quantity: number }>,
  snapshots: Map<string, ProductCostSnapshot>,
): { estimatedCurrentCost: Prisma.Decimal | null; hasUnknownCost: boolean } {
  let total = new Prisma.Decimal(0);
  for (const line of lines) {
    const snap = snapshots.get(line.productId);
    if (!snap) {
      return { estimatedCurrentCost: null, hasUnknownCost: true };
    }
    const unit = resolveComponentUnitCost(snap);
    if (unit === null) {
      return { estimatedCurrentCost: null, hasUnknownCost: true };
    }
    total = total.plus(unit.mul(line.quantity));
  }
  return { estimatedCurrentCost: total, hasUnknownCost: false };
}

export function computeMargin(
  salePrice: Prisma.Decimal,
  estimatedCurrentCost: Prisma.Decimal | null,
): { margin: MoneyString | null; marginPercent: MoneyString | null } {
  if (estimatedCurrentCost === null) {
    return { margin: null, marginPercent: null };
  }
  const margin = salePrice.minus(estimatedCurrentCost);
  const marginStr = margin.toFixed(2);
  if (salePrice.lessThanOrEqualTo(0)) {
    return { margin: marginStr, marginPercent: null };
  }
  const pct = margin.div(salePrice).mul(100).toFixed(2);
  return { margin: marginStr, marginPercent: pct };
}

export function buildCompositionPreview(
  items: Array<{ quantity: number; productName: string }>,
  maxParts = 3,
): string {
  if (items.length === 0) return '';
  const parts = items.slice(0, maxParts).map((i) => `${i.quantity}× ${i.productName}`);
  const rest = items.length - maxParts;
  if (rest > 0) {
    parts.push(`+ ещё ${rest}`);
  }
  return parts.join(' · ');
}

export function toBouquetListItem(
  bouquet: {
    id: string;
    name: string;
    description: string | null;
    salePrice: Prisma.Decimal;
    isActive: boolean;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    items: RecipeLine[];
  },
  snapshots: Map<string, ProductCostSnapshot>,
  includePurchase: boolean,
): BouquetListItem {
  const lines = bouquet.items.map((i) => ({
    productId: i.productId,
    quantity: i.quantity,
    productType: i.product.type,
  }));
  const { availableBouquets, hasInactiveComponents } = computeAvailableBouquets(lines, snapshots);
  const flowerComponentCount = bouquet.items.filter(
    (i) => i.product.type === ProductType.FLOWER,
  ).length;

  const base: BouquetListItem = {
    id: bouquet.id,
    name: bouquet.name,
    description: bouquet.description,
    salePrice: decimalToMoneyString(bouquet.salePrice)!,
    isActive: bouquet.isActive,
    version: bouquet.version,
    componentCount: bouquet.items.length,
    flowerComponentCount,
    compositionPreview: buildCompositionPreview(
      bouquet.items.map((i) => ({ quantity: i.quantity, productName: i.product.name })),
    ),
    availableBouquets,
    hasInactiveComponents,
    createdAt: bouquet.createdAt.toISOString(),
    updatedAt: bouquet.updatedAt.toISOString(),
  };

  if (includePurchase) {
    const { estimatedCurrentCost, hasUnknownCost } = computeEstimatedBouquetCost(lines, snapshots);
    base.hasUnknownCost = hasUnknownCost;
    base.estimatedCurrentCost =
      estimatedCurrentCost === null ? null : estimatedCurrentCost.toFixed(2);
    const { margin, marginPercent } = computeMargin(bouquet.salePrice, estimatedCurrentCost);
    base.estimatedMargin = margin;
    base.estimatedMarginPercent = marginPercent;
  }

  return base;
}

export function toBouquetItemDto(
  item: {
    id: string;
    productId: string;
    quantity: number;
    product: {
      name: string;
      sku: string | null;
      type: ProductType | string;
      unit: string;
      isActive: boolean;
    };
  },
  snap: ProductCostSnapshot | undefined,
  includePurchase: boolean,
): BouquetItemDto {
  const dto: BouquetItemDto = {
    id: item.id,
    productId: item.productId,
    productName: item.product.name,
    productSku: item.product.sku,
    productType: item.product.type as ProductType,
    unit: item.product.unit as Unit,
    quantity: item.quantity,
    isActive: item.product.isActive,
    availableStock:
      item.product.type === ProductType.FLOWER ? (snap?.availableQuantity ?? 0) : null,
  };
  if (includePurchase && snap) {
    const unit = resolveComponentUnitCost(snap);
    dto.currentComponentCost = unit === null ? null : unit.toFixed(2);
    dto.estimatedLineCost = unit === null ? null : unit.mul(item.quantity).toFixed(2);
  }
  return dto;
}
