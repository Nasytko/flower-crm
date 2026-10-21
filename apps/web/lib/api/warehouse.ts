import type {
  AssembledBouquetDetail,
  AssembledBouquetListItem,
  WarehouseStockDetailDto,
  WarehouseStockRowDto,
} from '@erp/shared';
import { apiFetch } from './client';

export async function listWarehouseStock(): Promise<WarehouseStockRowDto[]> {
  return apiFetch<WarehouseStockRowDto[]>('/api/v1/warehouse/stock');
}

export async function getWarehouseStockDetail(productId: string): Promise<WarehouseStockDetailDto> {
  return apiFetch<WarehouseStockDetailDto>(`/api/v1/warehouse/stock/${productId}`);
}

export async function listAssembledBouquets(
  productId?: string,
): Promise<AssembledBouquetListItem[]> {
  const qs = productId ? `?productId=${encodeURIComponent(productId)}` : '';
  return apiFetch<AssembledBouquetListItem[]>(`/api/v1/assembled-bouquets${qs}`);
}

export async function getAssembledBouquet(id: string): Promise<AssembledBouquetDetail> {
  return apiFetch<AssembledBouquetDetail>(`/api/v1/assembled-bouquets/${id}`);
}

export type AssembleBouquetInput = {
  orderId?: string;
  orderItemId?: string;
  bouquetTemplateId?: string;
  nameSnapshot: string;
  components: Array<{ productId: string; quantity: number }>;
  idempotencyKey?: string;
  allowReserveOverride?: boolean;
  expectedOrderVersion?: number;
};

export async function assembleBouquet(
  input: AssembleBouquetInput,
): Promise<AssembledBouquetDetail> {
  return apiFetch<AssembledBouquetDetail>('/api/v1/assembled-bouquets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function disassembleBouquet(
  id: string,
  input: {
    expectedVersion: number;
    reason: string;
    lines: Array<{ productId: string; returnQuantity: number; damageQuantity: number }>;
  },
): Promise<AssembledBouquetDetail> {
  return apiFetch<AssembledBouquetDetail>(`/api/v1/assembled-bouquets/${id}/disassemble`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function adjustBouquet(
  id: string,
  input: {
    expectedVersion: number;
    components: Array<{ productId: string; quantity: number; damageQuantity?: number }>;
    allowReserveOverride?: boolean;
    reason?: string;
  },
): Promise<AssembledBouquetDetail> {
  return apiFetch<AssembledBouquetDetail>(`/api/v1/assembled-bouquets/${id}/adjust`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function issueBouquet(
  id: string,
  expectedVersion: number,
): Promise<AssembledBouquetDetail> {
  return apiFetch<AssembledBouquetDetail>(`/api/v1/assembled-bouquets/${id}/issue`, {
    method: 'POST',
    body: JSON.stringify({ expectedVersion }),
  });
}

export async function writeOffBouquet(
  id: string,
  input: { expectedVersion: number; reason: string },
): Promise<AssembledBouquetDetail> {
  return apiFetch<AssembledBouquetDetail>(`/api/v1/assembled-bouquets/${id}/write-off`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function directIssueOrderItem(
  orderId: string,
  input: { orderItemId: string; quantity: number; expectedOrderVersion: number },
): Promise<void> {
  await apiFetch(`/api/v1/orders/${orderId}/direct-issue`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
