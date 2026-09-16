import type { QueryClient } from '@tanstack/react-query';

/** Invalidate views that show stock / reservations after warehouse-affecting mutations. */
export async function invalidateStockViews(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['products'] }),
    qc.invalidateQueries({ queryKey: ['bouquets'] }),
    qc.invalidateQueries({ queryKey: ['orders'] }),
    qc.invalidateQueries({ queryKey: ['inventories', 'active'] }),
  ]);
}
