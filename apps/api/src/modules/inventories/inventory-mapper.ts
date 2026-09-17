import type {
  ActiveInventoryInfo,
  InventoryDetail,
  InventoryItemDto,
  InventoryListItem,
} from '@erp/shared';
import { InventoryStatus } from '@erp/shared';

export function formatInventoryNumber(number: number): string {
  return `INV-${String(number).padStart(6, '0')}`;
}

export type InventoryItemSummaryRow = {
  expectedQuantity: number;
  countedQuantity: number | null;
};

export type InventoryListSummary = {
  itemCount: number;
  countedItemCount: number;
  differenceItemCount: number;
  positiveQuantity: number;
  negativeQuantity: number;
};

type SessionHeader = {
  id: string;
  number: number;
  status: InventoryStatus | string;
  comment: string | null;
  createdByUserId?: string;
  completedByUserId?: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt?: Date;
  createdBy: { id?: string; name: string };
  completedBy?: { id?: string; name: string } | null;
};

type SessionRow = SessionHeader & {
  createdByUserId: string;
  completedByUserId: string | null;
  cancelledAt: Date | null;
  updatedAt: Date;
  createdBy: { id: string; name: string };
  completedBy?: { id: string; name: string } | null;
  items: Array<{
    id: string;
    productId: string;
    expectedQuantity: number;
    countedQuantity: number | null;
    countedByUserId: string | null;
    countedAt: Date | null;
    product: { id: string; name: string; sku: string | null };
    countedBy?: { id: string; name: string } | null;
  }>;
};

export function toInventoryItemDto(item: SessionRow['items'][number]): InventoryItemDto {
  const counted = item.countedQuantity;
  return {
    id: item.id,
    productId: item.productId,
    productName: item.product.name,
    productSku: item.product.sku,
    expectedQuantity: item.expectedQuantity,
    countedQuantity: counted,
    difference: counted === null ? null : counted - item.expectedQuantity,
    countedByUserId: item.countedByUserId,
    countedByName: item.countedBy?.name ?? null,
    countedAt: item.countedAt?.toISOString() ?? null,
  };
}

/** Same semantics as inventory list SQL FILTER aggregates (counts only). */
export function summarizeItems(items: InventoryItemSummaryRow[]): InventoryListSummary {
  const itemCount = items.length;
  const countedItemCount = items.filter((i) => i.countedQuantity !== null).length;
  let differenceItemCount = 0;
  let positiveQuantity = 0;
  let negativeQuantity = 0;
  for (const item of items) {
    if (item.countedQuantity === null) continue;
    const diff = item.countedQuantity - item.expectedQuantity;
    if (diff !== 0) differenceItemCount += 1;
    if (diff > 0) positiveQuantity += diff;
    if (diff < 0) negativeQuantity += Math.abs(diff);
  }
  return { itemCount, countedItemCount, differenceItemCount, positiveQuantity, negativeQuantity };
}

export function toInventoryListItem(
  row: SessionHeader,
  summary: Pick<
    InventoryListSummary,
    'itemCount' | 'countedItemCount' | 'differenceItemCount'
  >,
): InventoryListItem {
  return {
    id: row.id,
    number: row.number,
    numberLabel: formatInventoryNumber(row.number),
    status: row.status as InventoryStatus,
    comment: row.comment,
    itemCount: summary.itemCount,
    countedItemCount: summary.countedItemCount,
    differenceItemCount: summary.differenceItemCount,
    createdByName: row.createdBy.name,
    completedByName: row.completedBy?.name ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toInventoryDetail(row: SessionRow): InventoryDetail {
  const summary = summarizeItems(row.items);
  return {
    ...toInventoryListItem(row, summary),
    createdByUserId: row.createdByUserId,
    completedByUserId: row.completedByUserId,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    positiveQuantity: summary.positiveQuantity,
    negativeQuantity: summary.negativeQuantity,
    items: row.items.map(toInventoryItemDto),
  };
}

export function toActiveInventoryInfo(row: SessionRow): ActiveInventoryInfo {
  const summary = summarizeItems(row.items);
  return {
    id: row.id,
    number: row.number,
    numberLabel: formatInventoryNumber(row.number),
    status: row.status as InventoryStatus,
    startedAt: row.startedAt?.toISOString() ?? null,
    itemCount: summary.itemCount,
    countedItemCount: summary.countedItemCount,
  };
}
