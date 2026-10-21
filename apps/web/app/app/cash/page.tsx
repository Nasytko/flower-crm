'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { closeCashShift, getCashShift, getCurrentCashShift, openCashShift } from '@/lib/api/cash';
import { userFacingError } from '@/lib/api/error-messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';

export default function CashPage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [float, setFloat] = useState('0.00');
  const [counted, setCounted] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.CASH_SHIFT_MANAGE)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  const currentQuery = useQuery({
    queryKey: ['cash', 'current'],
    queryFn: () => getCurrentCashShift(),
    enabled: Boolean(user && hasPermission(Permission.CASH_SHIFT_MANAGE)),
  });

  const detailQuery = useQuery({
    queryKey: ['cash', 'shift', currentQuery.data?.shift?.id],
    queryFn: () => getCashShift(currentQuery.data!.shift!.id),
    enabled: Boolean(currentQuery.data?.shift?.id),
  });

  const openMut = useMutation({
    mutationFn: () => openCashShift({ openingFloat: float || '0.00' }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['cash'] });
    },
    onError: (err) => setError(userFacingError(err, 'Не удалось открыть смену')),
  });

  const closeMut = useMutation({
    mutationFn: () =>
      closeCashShift(currentQuery.data!.shift!.id, { countedCash: counted || '0.00' }),
    onSuccess: async () => {
      setError(null);
      setCounted('');
      await queryClient.invalidateQueries({ queryKey: ['cash'] });
    },
    onError: (err) => setError(userFacingError(err, 'Не удалось закрыть смену')),
  });

  if (!bootstrapped || !user || !hasPermission(Permission.CASH_SHIFT_MANAGE)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  const shift = currentQuery.data?.shift;
  const detail = detailQuery.data;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="Касса" description="Внутренняя кассовая смена ERP (не фискальная)" />
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      {!shift ? (
        <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Открыть смену</h2>
          <div className="space-y-2">
            <Label htmlFor="opening-float">Начальный остаток наличных (BYN)</Label>
            <Input
              id="opening-float"
              inputMode="decimal"
              value={float}
              onChange={(e) => setFloat(e.target.value)}
            />
          </div>
          <Button
            disabled={openMut.isPending}
            onClick={() => openMut.mutate()}
            className="min-h-11 w-full"
          >
            {openMut.isPending ? 'Открытие…' : 'Открыть смену'}
          </Button>
        </section>
      ) : (
        <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Открытая смена</h2>
          <p className="text-sm text-muted-foreground">
            {shift.cashRegisterName} · открыл {shift.openedByName} ·{' '}
            {new Date(shift.openedAt).toLocaleString('ru-RU')}
          </p>
          <p className="text-sm">
            Начало: <span className="tabular-nums font-medium">{shift.openingFloat} BYN</span>
          </p>
          {detail ? (
            <div className="space-y-1 text-sm">
              <p>
                Ожидается:{' '}
                <span className="tabular-nums font-medium">{detail.summary.expectedCash} BYN</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Продажи {detail.summary.saleIn} · возвраты {detail.summary.refundOut} · внесения{' '}
                {detail.summary.floatIn} · изъятия {detail.summary.floatOut}
              </p>
            </div>
          ) : null}
          <div className="space-y-2 border-t border-border pt-4">
            <Label htmlFor="counted-cash">Фактический остаток при закрытии</Label>
            <Input
              id="counted-cash"
              inputMode="decimal"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              placeholder={detail?.summary.expectedCash ?? '0.00'}
            />
            <Button
              variant="destructive"
              disabled={closeMut.isPending}
              onClick={() => closeMut.mutate()}
              className="min-h-11 w-full"
            >
              {closeMut.isPending ? 'Закрытие…' : 'Закрыть смену'}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
