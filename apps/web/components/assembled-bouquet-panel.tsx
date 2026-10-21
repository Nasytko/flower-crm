'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AssembledBouquetStatus,
  ASSEMBLED_BOUQUET_STATUS_LABELS_RU,
  Permission,
  type AssembledBouquetDetail,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import {
  adjustBouquet,
  disassembleBouquet,
  getAssembledBouquet,
  issueBouquet,
  writeOffBouquet,
} from '@/lib/api/warehouse';
import { userFacingError } from '@/lib/api/error-messages';
import { invalidateAfterBouquetStockMutation } from '@/lib/query-invalidation';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Mode = 'view' | 'disassemble' | 'adjust' | 'writeOff';

export function AssembledBouquetPanel({
  bouquetId,
  onClose,
  onChanged,
}: {
  bouquetId: string;
  onClose: () => void;
  onChanged?: (detail: AssembledBouquetDetail) => void;
}): ReactElement {
  const { hasPermission } = useAuth();
  const canAssemble = hasPermission(Permission.ORDERS_ASSEMBLE);
  const canIssue = hasPermission(Permission.ORDERS_ISSUE);
  const canOverride = hasPermission(Permission.ORDERS_RESERVE_OVERRIDE);
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [error, setError] = useState<string | null>(null);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [reason, setReason] = useState('');
  const [allowOverride, setAllowOverride] = useState(false);

  const detailQuery = useQuery({
    queryKey: queryKeys.assembledBouquet(bouquetId),
    queryFn: () => getAssembledBouquet(bouquetId),
  });

  const detail = detailQuery.data;

  const [disassembleLines, setDisassembleLines] = useState<
    Array<{ productId: string; name: string; total: number; returnQty: string; damageQty: string }>
  >([]);
  const [adjustLines, setAdjustLines] = useState<
    Array<{ productId: string; name: string; quantity: string; damageQty: string }>
  >([]);

  function startDisassemble(components: AssembledBouquetDetail['components']): void {
    setDisassembleLines(
      components.map((c) => ({
        productId: c.productId,
        name: c.productNameSnapshot,
        total: c.quantity,
        returnQty: String(c.quantity),
        damageQty: '0',
      })),
    );
    setMode('disassemble');
  }

  function startAdjust(components: AssembledBouquetDetail['components']): void {
    setAdjustLines(
      components.map((c) => ({
        productId: c.productId,
        name: c.productNameSnapshot,
        quantity: String(c.quantity),
        damageQty: '0',
      })),
    );
    setMode('adjust');
  }

  const mutationOpts = {
    onSuccess: async (updated: AssembledBouquetDetail) => {
      setError(null);
      setMode('view');
      setConfirmIssue(false);
      setReason('');
      await invalidateAfterBouquetStockMutation(queryClient);
      await detailQuery.refetch();
      onChanged?.(updated);
    },
    onError: (err: unknown) => {
      setError(userFacingError(err, 'Не удалось выполнить операцию'));
      setConfirmIssue(false);
    },
  };

  const issueMut = useMutation({
    mutationFn: () => issueBouquet(bouquetId, detail!.version),
    ...mutationOpts,
  });
  const disassembleMut = useMutation({
    mutationFn: () =>
      disassembleBouquet(bouquetId, {
        expectedVersion: detail!.version,
        reason: reason.trim(),
        lines: disassembleLines.map((l) => ({
          productId: l.productId,
          returnQuantity: Number.parseInt(l.returnQty, 10) || 0,
          damageQuantity: Number.parseInt(l.damageQty, 10) || 0,
        })),
      }),
    ...mutationOpts,
  });
  const adjustMut = useMutation({
    mutationFn: () =>
      adjustBouquet(bouquetId, {
        expectedVersion: detail!.version,
        allowReserveOverride: allowOverride && canOverride,
        reason: reason.trim() || undefined,
        components: adjustLines.map((l) => ({
          productId: l.productId,
          quantity: Number.parseInt(l.quantity, 10) || 0,
          damageQuantity: Number.parseInt(l.damageQty, 10) || 0,
        })),
      }),
    ...mutationOpts,
  });
  const writeOffMut = useMutation({
    mutationFn: () =>
      writeOffBouquet(bouquetId, {
        expectedVersion: detail!.version,
        reason: reason.trim(),
      }),
    ...mutationOpts,
  });

  const busy =
    issueMut.isPending || disassembleMut.isPending || adjustMut.isPending || writeOffMut.isPending;

  const isAssembled = detail?.status === AssembledBouquetStatus.ASSEMBLED;

  const disassembleValid = useMemo(() => {
    if (!reason.trim()) return false;
    return disassembleLines.every((l) => {
      const r = Number.parseInt(l.returnQty, 10) || 0;
      const d = Number.parseInt(l.damageQty, 10) || 0;
      return r >= 0 && d >= 0 && r + d === l.total;
    });
  }, [disassembleLines, reason]);

  if (detailQuery.isLoading) {
    return (
      <div className="rounded-[28px] border border-border bg-card p-6 text-sm text-muted-foreground">
        Загрузка букета…
      </div>
    );
  }
  if (detailQuery.isError || !detail) {
    return (
      <div className="space-y-3 rounded-[28px] border border-border bg-card p-6">
        <p className="text-sm text-danger-fg">Не удалось загрузить букет</p>
        <Button type="button" variant="outline" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{detail.nameSnapshot}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {detail.number} · {ASSEMBLED_BOUQUET_STATUS_LABELS_RU[detail.status]}
            {detail.orderNumber ? ` · заказ ${detail.orderNumber}` : ' · витрина'}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </header>

      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              <th className="py-2 font-medium">Компонент</th>
              <th className="py-2 font-medium">Кол-во</th>
            </tr>
          </thead>
          <tbody>
            {detail.components.map((c) => (
              <tr key={c.id} className="border-b border-border/70">
                <td className="py-2">{c.productNameSnapshot}</td>
                <td className="py-2 tabular-nums">{c.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {mode === 'view' && isAssembled ? (
        <div className="flex flex-wrap gap-2">
          {canIssue ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => setConfirmIssue(true)}>
              Выдать
            </Button>
          ) : null}
          {canAssemble ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => startAdjust(detail.components)}
              >
                Изменить состав
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => startDisassemble(detail.components)}
              >
                Расформировать
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setMode('writeOff')}
              >
                Списать
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {mode === 'disassemble' ? (
        <div className="space-y-3 rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium">Расформирование</p>
          <p className="text-xs text-muted-foreground">
            Укажите, сколько цветов вернуть на полку и сколько списать как повреждённые. Сумма
            должна совпадать с составом.
          </p>
          {disassembleLines.map((l) => (
            <div key={l.productId} className="grid gap-2 sm:grid-cols-[1fr_5rem_5rem]">
              <p className="text-sm">
                {l.name} <span className="text-muted-foreground">(всего {l.total})</span>
              </p>
              <div>
                <Label className="text-xs">Пригодны</Label>
                <Input
                  inputMode="numeric"
                  value={l.returnQty}
                  onChange={(e) =>
                    setDisassembleLines((prev) =>
                      prev.map((x) =>
                        x.productId === l.productId
                          ? { ...x, returnQty: e.target.value.replace(/[^\d]/g, '') }
                          : x,
                      ),
                    )
                  }
                />
              </div>
              <div>
                <Label className="text-xs">Повреждены</Label>
                <Input
                  inputMode="numeric"
                  value={l.damageQty}
                  onChange={(e) =>
                    setDisassembleLines((prev) =>
                      prev.map((x) =>
                        x.productId === l.productId
                          ? { ...x, damageQty: e.target.value.replace(/[^\d]/g, '') }
                          : x,
                      ),
                    )
                  }
                />
              </div>
            </div>
          ))}
          <div>
            <Label>Причина</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: срочный заказ"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !disassembleValid}
              onClick={() => disassembleMut.mutate()}
            >
              Подтвердить разбор
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setMode('view')}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'adjust' ? (
        <div className="space-y-3 rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium">Корректировка состава</p>
          {(adjustLines ?? []).map((l) => (
            <div key={l.productId} className="grid gap-2 sm:grid-cols-[1fr_5rem_5rem]">
              <p className="text-sm">{l.name}</p>
              <div>
                <Label className="text-xs">Итого</Label>
                <Input
                  inputMode="numeric"
                  value={l.quantity}
                  onChange={(e) =>
                    setAdjustLines((prev) =>
                      (prev ?? []).map((x) =>
                        x.productId === l.productId
                          ? { ...x, quantity: e.target.value.replace(/[^\d]/g, '') }
                          : x,
                      ),
                    )
                  }
                />
              </div>
              <div>
                <Label className="text-xs">Из них брак</Label>
                <Input
                  inputMode="numeric"
                  value={l.damageQty}
                  onChange={(e) =>
                    setAdjustLines((prev) =>
                      (prev ?? []).map((x) =>
                        x.productId === l.productId
                          ? { ...x, damageQty: e.target.value.replace(/[^\d]/g, '') }
                          : x,
                      ),
                    )
                  }
                />
              </div>
            </div>
          ))}
          {canOverride ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowOverride}
                onChange={(e) => setAllowOverride(e.target.checked)}
              />
              Разрешить взять цветы из резерва срочных заказов
            </label>
          ) : null}
          <div>
            <Label>Комментарий</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => adjustMut.mutate()}>
              Сохранить состав
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setMode('view')}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'writeOff' ? (
        <div className="space-y-3 rounded-2xl border border-danger-fg/30 bg-danger-soft/40 p-4">
          <p className="text-sm font-medium text-danger-fg">Списание всего букета</p>
          <p className="text-xs text-muted-foreground">
            Все компоненты будут списаны без возврата на полку. Это действие нельзя отменить.
          </p>
          <div>
            <Label>Причина</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !reason.trim()}
              onClick={() => writeOffMut.mutate()}
            >
              Списать букет
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setMode('view')}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmIssue}
        title={`Выдать букет ${detail.number}?`}
        description="Букет покинет магазин. Цветы окончательно спишутся из остатков «в букетах»."
        confirmLabel="Выдать"
        busy={busy}
        onCancel={() => setConfirmIssue(false)}
        onConfirm={() => issueMut.mutate()}
      />
    </div>
  );
}

export function AssembledBouquetStatusBadge({
  status,
}: {
  status: AssembledBouquetStatus;
}): ReactElement {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        status === AssembledBouquetStatus.ASSEMBLED && 'bg-success-soft text-success-fg',
        status === AssembledBouquetStatus.ISSUED && 'bg-muted text-muted-foreground',
        status === AssembledBouquetStatus.DISASSEMBLED && 'bg-warn-soft text-warn-fg',
        status === AssembledBouquetStatus.WRITTEN_OFF && 'bg-danger-soft text-danger-fg',
      )}
    >
      {ASSEMBLED_BOUQUET_STATUS_LABELS_RU[status]}
    </span>
  );
}
