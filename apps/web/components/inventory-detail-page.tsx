'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InventoryStatus, Permission, type InventoryItemDto } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import {
  cancelInventory,
  completeInventory,
  getInventory,
  updateInventoryItem,
} from '@/lib/api/inventories';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { StatRow } from '@/components/ui/stat-row';
import { StickyActionBar } from '@/components/ui/sticky-action-bar';
import { cn } from '@/lib/utils';
import { InventoryStatusBadge } from '@/components/inventories-page';
import { userFacingError } from '@/lib/api/error-messages';
import {
  invalidateAfterInventoryCancel,
  invalidateAfterInventoryComplete,
} from '@/lib/query-invalidation';

type CountFilter = 'all' | 'uncounted' | 'counted' | 'diff';

export function InventoryDetailPage({ inventoryId }: { inventoryId: string }): ReactElement {
  const { hasPermission } = useAuth();
  const canCount = hasPermission(Permission.INVENTORY_COUNT);
  const canManage = hasPermission(Permission.INVENTORY_MANAGE);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CountFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: queryKeys.inventory(inventoryId),
    queryFn: () => getInventory(inventoryId),
  });

  const detail = query.data;
  const inProgress = detail?.status === InventoryStatus.IN_PROGRESS;

  const filteredItems = useMemo(() => {
    const items = detail?.items ?? [];
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (q) {
        const hay = `${item.productName} ${item.productSku ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === 'uncounted') return item.countedQuantity === null;
      if (filter === 'counted') return item.countedQuantity !== null;
      if (filter === 'diff') {
        return item.difference !== null && item.difference !== 0;
      }
      return true;
    });
  }, [detail?.items, search, filter]);

  const saveCount = async (item: InventoryItemDto, raw: string) => {
    if (!canCount || !inProgress) return;
    if (raw.trim() === '') return;
    const qty = Number.parseInt(raw, 10);
    if (!Number.isInteger(qty) || qty < 0) {
      setError('Количество должно быть целым числом ≥ 0');
      return;
    }
    if (item.countedQuantity === qty) return;

    setSavingIds((prev) => new Set(prev).add(item.id));
    try {
      const updated = await updateInventoryItem(inventoryId, item.id, qty);
      await queryClient.invalidateQueries({ queryKey: queryKeys.inventory(inventoryId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.activeInventory });
      setMessage(`Сохранено: ${updated.productName}`);
      setError(null);
    } catch (err) {
      setError(userFacingError(err, 'Ошибка сохранения'));
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const completeMutation = useMutation({
    mutationFn: () => completeInventory(inventoryId),
    onSuccess: async () => {
      setConfirmComplete(false);
      setMessage('Инвентаризация завершена');
      await invalidateAfterInventoryComplete(queryClient);
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка завершения'));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelInventory(inventoryId, cancelReason.trim() || null),
    onSuccess: async () => {
      setCancelOpen(false);
      setMessage('Инвентаризация отменена');
      await invalidateAfterInventoryCancel(queryClient);
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка отмены'));
    },
  });

  if (query.isLoading) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }
  if (query.isError || !detail) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-danger-fg">Не удалось загрузить инвентаризацию</p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>
          Повторить
        </Button>
      </div>
    );
  }

  const allCounted = detail.countedItemCount === detail.itemCount;
  const canComplete = canManage && inProgress && allCounted;
  const showManageActions = canManage && (detail.status === InventoryStatus.DRAFT || inProgress);
  const showCompleteAction = canManage && inProgress;
  const progressLabel = `Посчитано ${detail.countedItemCount} из ${detail.itemCount}`;

  return (
    <div
      className={cn('space-y-6', showManageActions || showCompleteAction ? 'pb-24 sm:pb-0' : null)}
    >
      <PageHeader
        title={`Инвентаризация №${String(detail.number).padStart(6, '0')}`}
        description={
          <div className="space-y-1">
            <Link href="/app/inventories" className="text-sm text-muted-foreground hover:underline">
              ← К списку
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <InventoryStatusBadge status={detail.status} />
              <span>
                Создал: {detail.createdByName}
                {detail.startedAt
                  ? ` · начата ${new Date(detail.startedAt).toLocaleString('ru-RU')}`
                  : null}
              </span>
            </div>
            {inProgress ? (
              <p className="font-medium text-foreground tabular-nums">{progressLabel}</p>
            ) : null}
          </div>
        }
        actions={
          showManageActions || showCompleteAction ? (
            <div className="hidden flex-wrap gap-2 sm:flex">
              {showManageActions ? (
                <Button type="button" variant="outline" onClick={() => setCancelOpen(true)}>
                  Отменить
                </Button>
              ) : null}
              {showCompleteAction ? (
                <Button
                  type="button"
                  disabled={!canComplete}
                  title={!allCounted ? 'Сначала посчитайте все позиции' : undefined}
                  onClick={() => setConfirmComplete(true)}
                >
                  Завершить инвентаризацию
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />

      {inProgress ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{
              width: `${detail.itemCount === 0 ? 0 : (detail.countedItemCount / detail.itemCount) * 100}%`,
            }}
          />
        </div>
      ) : null}

      {message ? (
        <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      {!inProgress && detail.status === InventoryStatus.COMPLETED ? (
        <div className="rounded-[28px] border border-border bg-card px-6 py-4 text-sm">
          <div className="font-medium">Итог</div>
          <div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
            <div>Позиций: {detail.itemCount}</div>
            <div>С расхождением: {detail.differenceItemCount}</div>
            <div>Увеличение: +{detail.positiveQuantity} шт.</div>
            <div>Уменьшение: −{detail.negativeQuantity} шт.</div>
          </div>
        </div>
      ) : null}

      {inProgress || detail.status === InventoryStatus.COMPLETED ? (
        <>
          <div className="flex flex-col gap-3">
            <Input
              className="w-full sm:max-w-sm"
              placeholder="Поиск по названию / SKU"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {(
                [
                  ['all', 'Все'],
                  ['uncounted', 'Не посчитаны'],
                  ['counted', 'Посчитаны'],
                  ['diff', 'С расхождением'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    'h-9 shrink-0 rounded-full px-3 text-sm',
                    filter === key ? 'bg-foreground text-background' : 'bg-muted text-foreground',
                  )}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <section className="overflow-hidden rounded-[28px] border border-border bg-card">
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Товар</th>
                    <th className="px-3 py-3 font-medium">Ожидалось</th>
                    <th className="px-3 py-3 font-medium">Фактически</th>
                    <th className="px-3 py-3 font-medium">Разница</th>
                    <th className="px-3 py-3 font-medium">Кто посчитал</th>
                    <th className="px-5 py-3 font-medium">Время</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <CountRow
                      key={`${item.id}-${item.countedQuantity}`}
                      item={item}
                      editable={canCount && inProgress}
                      saving={savingIds.has(item.id)}
                      onSave={(raw) => void saveCount(item, raw)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 p-3 md:hidden">
              {filteredItems.map((item) => (
                <CountCard
                  key={`${item.id}-${item.countedQuantity}`}
                  item={item}
                  editable={canCount && inProgress}
                  saving={savingIds.has(item.id)}
                  onSave={(raw) => void saveCount(item, raw)}
                />
              ))}
            </div>

            {filteredItems.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Нет позиций</div>
            ) : null}
          </section>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Черновик ещё не начат.</p>
      )}

      {showManageActions || showCompleteAction ? (
        <StickyActionBar className="sm:hidden">
          {showCompleteAction ? (
            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={!canComplete}
              title={!allCounted ? 'Сначала посчитайте все позиции' : undefined}
              onClick={() => setConfirmComplete(true)}
            >
              Завершить инвентаризацию
            </Button>
          ) : null}
          {showManageActions ? (
            <Button
              type="button"
              className="min-h-11 w-full"
              variant="outline"
              onClick={() => setCancelOpen(true)}
            >
              Отменить
            </Button>
          ) : null}
        </StickyActionBar>
      ) : null}

      <ResponsiveDialog
        open={confirmComplete && !!detail}
        onClose={() => setConfirmComplete(false)}
        title="Завершить инвентаризацию?"
        description="После завершения остатки будут скорректированы. Изменить эту инвентаризацию будет нельзя."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setConfirmComplete(false)}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={completeMutation.isPending}
              onClick={() => completeMutation.mutate()}
            >
              Завершить
            </Button>
          </div>
        }
      >
        <div className="space-y-1 text-sm text-muted-foreground">
          <div>Позиций: {detail.itemCount}</div>
          <div>Посчитано: {detail.countedItemCount}</div>
          <div>Расхождений: {detail.differenceItemCount}</div>
          <div>Увеличение: +{detail.positiveQuantity} шт.</div>
          <div>Уменьшение: −{detail.negativeQuantity} шт.</div>
        </div>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Отменить инвентаризацию?"
        description="Остатки не изменятся."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setCancelOpen(false)}>
              Назад
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={cancelMutation.isPending || (inProgress && cancelReason.trim().length < 3)}
              onClick={() => cancelMutation.mutate()}
            >
              Отменить документ
            </Button>
          </div>
        }
      >
        {inProgress ? (
          <Input
            placeholder="Причина отмены *"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Документ будет отменён без изменения остатков.
          </p>
        )}
      </ResponsiveDialog>
    </div>
  );
}

function formatDiff(diff: number | null): string {
  if (diff === null) return '—';
  return diff > 0 ? `+${diff}` : String(diff);
}

function diffClassName(diff: number | null): string {
  return cn(
    'tabular-nums',
    diff != null && diff < 0 && 'text-danger-fg',
    diff != null && diff > 0 && 'text-amber-700',
    diff === 0 && 'text-muted-foreground',
  );
}

function CountRow({
  item,
  editable,
  saving,
  onSave,
}: {
  item: InventoryItemDto;
  editable: boolean;
  saving: boolean;
  onSave: (raw: string) => void;
}): ReactElement {
  const [raw, setRaw] = useState(item.countedQuantity === null ? '' : String(item.countedQuantity));
  const parsed = raw.trim() === '' ? null : Number.parseInt(raw, 10);
  const diff =
    parsed !== null && Number.isInteger(parsed) ? parsed - item.expectedQuantity : item.difference;

  return (
    <tr className="border-b border-border/80">
      <td className="px-5 py-2.5">
        <div className="font-medium">{item.productName}</div>
        <div className="text-xs text-muted-foreground">{item.productSku ?? 'без SKU'}</div>
      </td>
      <td className="px-3 py-2.5 tabular-nums">{item.expectedQuantity}</td>
      <td className="px-3 py-2.5">
        {editable ? (
          <Input
            className="h-9 w-24"
            inputMode="numeric"
            value={raw}
            disabled={saving}
            placeholder="—"
            aria-label={`Факт: ${item.productName}`}
            onChange={(e) => setRaw(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => onSave(raw)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="tabular-nums">
            {item.countedQuantity === null ? '—' : item.countedQuantity}
          </span>
        )}
      </td>
      <td className={cn('px-3 py-2.5', diffClassName(diff))}>{formatDiff(diff)}</td>
      <td className="px-3 py-2.5">{item.countedByName ?? '—'}</td>
      <td className="px-5 py-2.5 text-muted-foreground">
        {item.countedAt ? new Date(item.countedAt).toLocaleString('ru-RU') : '—'}
      </td>
    </tr>
  );
}

function CountCard({
  item,
  editable,
  saving,
  onSave,
}: {
  item: InventoryItemDto;
  editable: boolean;
  saving: boolean;
  onSave: (raw: string) => void;
}): ReactElement {
  const [raw, setRaw] = useState(item.countedQuantity === null ? '' : String(item.countedQuantity));
  const isEmpty = raw.trim() === '';
  const parsed = isEmpty ? null : Number.parseInt(raw, 10);
  const diff =
    parsed !== null && Number.isInteger(parsed) ? parsed - item.expectedQuantity : item.difference;
  const notCounted = item.countedQuantity === null && isEmpty;

  return (
    <div
      className={cn(
        'rounded-2xl border px-4 py-3',
        notCounted ? 'border-dashed border-border bg-muted/20' : 'border-border/80 bg-card',
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium leading-snug">{item.productName}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{item.productSku ?? 'без SKU'}</p>
      </div>

      <div className="mt-3 space-y-2">
        <StatRow label="Ожидалось" value={item.expectedQuantity} />

        <div className="space-y-1.5">
          <label htmlFor={`count-${item.id}`} className="text-sm text-muted-foreground">
            Фактически
          </label>
          {editable ? (
            <Input
              id={`count-${item.id}`}
              className={cn(
                'min-h-12 w-full text-lg tabular-nums',
                isEmpty && 'border-dashed text-muted-foreground',
              )}
              inputMode="numeric"
              value={raw}
              disabled={saving}
              placeholder="Не посчитано"
              aria-label={`Факт: ${item.productName}`}
              onChange={(e) => setRaw(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => onSave(raw)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <p
              className={cn(
                'flex min-h-12 items-center rounded-xl border border-border/60 px-3 text-lg tabular-nums',
                item.countedQuantity === null && 'border-dashed text-muted-foreground',
              )}
            >
              {item.countedQuantity === null ? 'Не посчитано' : item.countedQuantity}
            </p>
          )}
        </div>

        {!isEmpty || item.difference !== null ? (
          <StatRow
            label="Разница"
            value={formatDiff(diff)}
            emphasize={diff != null && diff !== 0}
            className={diffClassName(diff)}
          />
        ) : null}
      </div>
    </div>
  );
}
