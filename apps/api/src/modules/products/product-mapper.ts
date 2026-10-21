import { Prisma } from '@erp/database';
import {
  ProductAttrKind,
  ProductType,
  type ProductAttributeValueDto,
  type ProductImageDto,
  type ProductListItem,
  type ProductStockDto,
} from '@erp/shared';
import type { ProductImagesService } from './product-images.service';

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
    quantityInBouquets?: number;
  } | null,
): ProductStockDto | null {
  if (!stock) {
    return null;
  }
  const quantityInBouquets = stock.quantityInBouquets ?? 0;
  return {
    quantityOnHand: stock.quantityOnHand,
    quantityReserved: stock.quantityReserved,
    availableQuantity: stock.quantityOnHand - stock.quantityReserved,
    quantityInBouquets,
    totalPhysical: stock.quantityOnHand + quantityInBouquets,
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

type AttrRow = {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  parentKey: string;
} | null;

type ImageRow = {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
};

function toAttrDto(row: AttrRow): ProductAttributeValueDto | null {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as ProductAttrKind,
    name: row.name,
    parentId: row.parentId,
    parentKey: row.parentKey,
  };
}

export const productFlowerInclude = {
  flowerKind: true,
  flowerForm: true,
  variety: true,
  color: true,
  origin: true,
  images: { orderBy: { sortOrder: 'asc' as const } },
} as const;

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
    flowerKindId?: string | null;
    flowerFormId?: string | null;
    varietyId?: string | null;
    colorId?: string | null;
    originId?: string | null;
    stemLengthCm?: number | null;
    primaryImageId?: string | null;
    flowerKind?: AttrRow;
    flowerForm?: AttrRow;
    variety?: AttrRow;
    color?: AttrRow;
    origin?: AttrRow;
    images?: ImageRow[];
    stock?: {
      quantityOnHand: number;
      quantityReserved: number;
      quantityInBouquets?: number;
    } | null;
    lots?: Array<{ remainingQuantity: number; unitPurchasePrice: Prisma.Decimal | null }>;
  },
  options: {
    includePurchasePrice: boolean;
    supplyCount?: number;
    imagesService?: Pick<ProductImagesService, 'toDto'>;
  },
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

  if (type === ProductType.FLOWER) {
    base.flowerKindId = product.flowerKindId ?? null;
    base.flowerFormId = product.flowerFormId ?? null;
    base.varietyId = product.varietyId ?? null;
    base.colorId = product.colorId ?? null;
    base.originId = product.originId ?? null;
    base.stemLengthCm = product.stemLengthCm ?? null;
    base.primaryImageId = product.primaryImageId ?? null;
    base.flowerKind = toAttrDto(product.flowerKind ?? null);
    base.flowerForm = toAttrDto(product.flowerForm ?? null);
    base.variety = toAttrDto(product.variety ?? null);
    base.color = toAttrDto(product.color ?? null);
    base.origin = toAttrDto(product.origin ?? null);

    const imagesService = options.imagesService;
    if (product.images && imagesService) {
      base.images = product.images.map((img) =>
        imagesService.toDto(img, product.primaryImageId ?? null),
      );
    } else if (product.images) {
      base.images = product.images.map((img): ProductImageDto => ({
        id: img.id,
        mimeType: img.mimeType,
        byteSize: img.byteSize,
        width: img.width,
        height: img.height,
        sortOrder: img.sortOrder,
        url: `/api/v1/product-images/${img.id}`,
        thumbUrl: `/api/v1/product-images/${img.id}?variant=thumb`,
        isPrimary: product.primaryImageId === img.id,
      }));
    } else {
      base.images = [];
    }
  }

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
