import type { EmployeeListItem, Role } from '@erp/shared';
import { apiFetch } from './client';

export async function listEmployees(): Promise<EmployeeListItem[]> {
  return apiFetch<EmployeeListItem[]>('/api/v1/employees');
}

export async function createEmployee(input: {
  name: string;
  login: string;
  email?: string | null;
  role: Role;
  password: string;
}): Promise<EmployeeListItem> {
  return apiFetch<EmployeeListItem>('/api/v1/employees', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateEmployee(
  id: string,
  input: Partial<{
    name: string;
    login: string;
    email: string | null;
    role: Role;
    isActive: boolean;
  }>,
): Promise<EmployeeListItem> {
  return apiFetch<EmployeeListItem>(`/api/v1/employees/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deactivateEmployee(id: string): Promise<EmployeeListItem> {
  return apiFetch<EmployeeListItem>(`/api/v1/employees/${id}/deactivate`, {
    method: 'POST',
  });
}

export async function resetEmployeePassword(id: string, newPassword: string): Promise<void> {
  await apiFetch<void>(`/api/v1/employees/${id}/password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });
}
