import type {
  CashMovementType,
  CashShiftDetailDto,
  CashShiftDto,
  CashShiftStatus,
} from '@erp/shared';
import { apiFetch } from './client';

export async function getCurrentCashShift(
  cashRegisterId?: string,
): Promise<{ shift: CashShiftDto | null }> {
  const q = cashRegisterId ? `?cashRegisterId=${encodeURIComponent(cashRegisterId)}` : '';
  return apiFetch<{ shift: CashShiftDto | null }>(`/api/v1/cash-shifts/current${q}`);
}

export async function listCashShifts(status?: CashShiftStatus): Promise<CashShiftDto[]> {
  const q = status ? `?status=${status}` : '';
  return apiFetch<CashShiftDto[]>(`/api/v1/cash-shifts${q}`);
}

export async function getCashShift(id: string): Promise<CashShiftDetailDto> {
  return apiFetch<CashShiftDetailDto>(`/api/v1/cash-shifts/${id}`);
}

export async function openCashShift(body: {
  cashRegisterId?: string;
  openingFloat: string;
  note?: string | null;
}): Promise<CashShiftDto> {
  return apiFetch<CashShiftDto>('/api/v1/cash-shifts/open', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function closeCashShift(
  id: string,
  body: { countedCash: string; note?: string | null },
): Promise<CashShiftDto> {
  return apiFetch<CashShiftDto>(`/api/v1/cash-shifts/${id}/close`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function addCashMovement(
  shiftId: string,
  body: { type: CashMovementType; amount: string; note?: string | null },
): Promise<CashShiftDetailDto> {
  return apiFetch<CashShiftDetailDto>(`/api/v1/cash-shifts/${shiftId}/movements`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
