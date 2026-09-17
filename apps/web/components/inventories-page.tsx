'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INVENTORY_STATUS_LABELS_RU, InventoryStatus, Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { getActiveInventory, listInventories, startNewInventory } from '@/lib/api/inventories';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { StatRow } from '@/components/ui/stat-row';
import { userFacingError } from '@/lib/api/error-messages';
import { invalidateAfterInventoryStart } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';

export function InventoriesPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.INVENTORY_MANAGE);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [startOpen, setStartOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const listQuery = useQuery({
    queryKey: queryKeys.inventories({ page }),
    queryFn: () => listInventories({ page, limit: 50 }),
  });

  const activeQuery = useQuery({
    queryKey: queryKeys.activeInventory,
    queryFn: getActiveInventory,
  });

  const startMutation = useMutation({
    mutationFn: () => startNewInventory({ comment: comment.trim() || null }),
    onSuccess: async (detail) => {
      setStartOpen(false);
      setComment('');
      await invalidateAfterInventoryStart(queryClient);
      router.push(`/app/inventories/${detail.id}`);
    },
    onError: (err) => {
      setError(userFacingError(err, 'Не удалось начать'));
    },
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));
  const active = activeQuery.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Инвентаризация"
        description="Сверка фактических остатков со снимком системы"
        actions={
          <>
            {active ? (
              <Button
                type="button"
                className="min-h-10"
                onClick={() => router.push(`/app/inventories/${active.id}`)}
              >
                Открыть текущую ({active.numberLabel})
              </Button>
            ) : null}
            {canManage && !active ? (
              <Button type="button" className="min-h-10" onClick={() => setStartOpen(true)}>
                + Новая инвентаризация
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        {listQuery.isLoading ? (
          <div className="p-8 text-sm text-muted-foreground">Загрузка...</div>
        ) : listQuery.isError ? (
          <div className="space-y-3 p-8 text-sm">
            <p className="text-danger-fg">Не удалось загрузить список</p>
            <Button type="button" variant="outline" onClick={() => void listQuery.refetch()}>
              Повторить
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            Инвентаризаций пока нет
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Номер</th>
                    <th className="px-3 py-3 font-medium">Начало</th>
                    <th className="px-3 py-3 font-medium">Статус</th>
                    <th className="px-3 py-3 font-medium">Позиций</th>
                    <th className="px-3 py-3 font-medium">Расхождений</th>
                    <th className="px-3 py-3 font-medium">Создал</th>
                    <th className="px-3 py-3 font-medium">Завершил</th>
                    <th className="px-3 py-3 font-medium">Завершение</th>
                    <th className="px-5 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} className="border-b border-border/80 hover:bg-muted/40">
                      <td className="px-5 py-3 font-medium">{row.numberLabel}</td>
                      <td className="px-3 py-3">
                        {row.startedAt ? new Date(row.startedAt).toLocaleString('ru-RU') : '—'}
                      </td>
                      <td className="px-3 py-3">
                        <InventoryStatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-3">
                        {row.countedItemCount}/{row.itemCount}
                      </td>
                      <td className="px-3 py-3">{row.differenceItemCount}</td>
                      <td className="px-3 py-3">{row.createdByName}</td>
                      <td className="px-3 py-3">{row.completedByName ?? '—'}</td>
                      <td className="px-3 py-3">
                        {row.completedAt ? new Date(row.completedAt).toLocaleString('ru-RU') : '—'}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/app/inventories/${row.id}`}
                          className="text-sm font-medium underline-offset-4 hover:underline"
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
                  href={`/app/inventories/${row.id}`}
                  className="block rounded-2xl border border-border/80 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{row.numberLabel}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {row.startedAt
                          ? new Date(row.startedAt).toLocaleString('ru-RU')
                          : 'Дата не указана'}
                      </p>
                    </div>
                    <InventoryStatusBadge status={row.status} />
                  </div>
                  <div className="mt-2 space-y-1">
                    <StatRow
                      label="Прогресс"
                      value={`${row.countedItemCount}/${row.itemCount}`}
                      emphasize
                    />
                    {row.differenceItemCount > 0 ? (
                      <StatRow label="Расхождений" value={row.differenceItemCount} />
                    ) : null}
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>

      {total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Всего: {total} · стр. {page}/{totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Назад
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Далее
            </Button>
          </div>
        </div>
      ) : null}

      <ResponsiveDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        title="Новая инвентаризация"
        description="Будет зафиксирован снимок ожидаемых остатков по всем активным цветам (и неактивным с остатком). Пока идёт подсчёт, поставки и списания недоступны."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setStartOpen(false)}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              Начать инвентаризацию
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="inv-comment">Комментарий</Label>
          <Input
            id="inv-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            placeholder="Необязательно"
          />
        </div>
      </ResponsiveDialog>
    </div>
  );
}

export function InventoryStatusBadge({ status }: { status: InventoryStatus }): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
        status === InventoryStatus.IN_PROGRESS && 'bg-primary-soft text-foreground',
        status === InventoryStatus.COMPLETED && 'bg-success-soft text-success-fg',
        status === InventoryStatus.DRAFT && 'bg-muted text-muted-foreground',
        status === InventoryStatus.CANCELLED && 'bg-danger-soft text-danger-fg',
      )}
    >
      {INVENTORY_STATUS_LABELS_RU[status]}
    </span>
  );
}
