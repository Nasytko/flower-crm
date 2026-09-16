'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Permission, SUPPLY_STATUS_LABELS_RU, SupplyStatus } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { listSupplies } from '@/lib/api/supplies';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { StatRow } from '@/components/ui/stat-row';
import { cn } from '@/lib/utils';

export function SuppliesPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission(Permission.SUPPLIES_CREATE);
  const canViewPrice = hasPermission(Permission.PURCHASE_PRICE_VIEW);
  const [page, setPage] = useState(1);
  const router = useRouter();

  const query = useQuery({
    queryKey: queryKeys.supplies({ page }),
    queryFn: () => listSupplies({ page, limit: 50 }),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Поставки"
        description="История документов прихода"
        actions={
          canCreate ? (
            <Button
              type="button"
              className="min-h-10 w-full sm:w-auto"
              onClick={() => router.push('/app/supplies/new')}
            >
              + Новая поставка
            </Button>
          ) : null
        }
      />

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        {query.isLoading ? (
          <div className="p-8 text-sm text-muted-foreground">Загрузка...</div>
        ) : query.isError ? (
          <div className="space-y-3 p-8 text-sm">
            <p className="text-danger-fg">Не удалось загрузить поставки</p>
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              Повторить
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">Поставок пока нет</div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Номер</th>
                    <th className="px-3 py-3 font-medium">Дата</th>
                    <th className="px-3 py-3 font-medium">Поставщик</th>
                    <th className="px-3 py-3 font-medium">Позиций</th>
                    <th className="px-3 py-3 font-medium">Кол-во</th>
                    {canViewPrice ? <th className="px-3 py-3 font-medium">Сумма</th> : null}
                    <th className="px-3 py-3 font-medium">Статус</th>
                    <th className="px-3 py-3 font-medium">Создал</th>
                    <th className="px-5 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} className="border-b border-border/80 hover:bg-muted/40">
                      <td className="px-5 py-3 font-medium">
                        {row.numberLabel}
                        {row.correctionOfNumber != null ? (
                          <div className="text-xs text-muted-foreground">
                            коррекция П-{String(row.correctionOfNumber).padStart(6, '0')}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">{row.documentDate}</td>
                      <td className="px-3 py-3">{row.supplierName ?? '—'}</td>
                      <td className="px-3 py-3">{row.itemCount}</td>
                      <td className="px-3 py-3">{row.totalQuantity}</td>
                      {canViewPrice ? (
                        <td className="px-3 py-3 tabular-nums">
                          {row.totalAmount != null ? `${row.totalAmount} BYN` : '—'}
                        </td>
                      ) : null}
                      <td className="px-3 py-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-3">{row.createdByName}</td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/app/supplies/${row.id}`}
                          className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          Открыть
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 p-3 md:hidden">
              {items.map((row) => (
                <Link
                  key={row.id}
                  href={`/app/supplies/${row.id}`}
                  className="block rounded-2xl border border-border/80 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{row.numberLabel}</p>
                      {row.correctionOfNumber != null ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          коррекция П-{String(row.correctionOfNumber).padStart(6, '0')}
                        </p>
                      ) : null}
                    </div>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="mt-2 space-y-1">
                    <StatRow label="Дата" value={row.documentDate} />
                    <StatRow label="Поставщик" value={row.supplierName ?? '—'} />
                    <StatRow label="Позиций" value={row.itemCount} />
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>

      {total > 0 ? (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            Всего: {total} · стр. {page}/{totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Назад
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: SupplyStatus }): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-3 py-1 text-xs font-semibold',
        status === SupplyStatus.POSTED && 'bg-success-soft text-success-fg',
        status === SupplyStatus.DRAFT && 'bg-warn-soft text-warn-fg',
        status === SupplyStatus.CANCELLED && 'bg-muted text-muted-foreground',
      )}
    >
      {SUPPLY_STATUS_LABELS_RU[status]}
    </span>
  );
}
