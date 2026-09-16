'use client';

import { useEffect, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission, SUPPLY_STATUS_LABELS_RU, SupplyStatus } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import {
  cancelSupply,
  correctSupply,
  getSupply,
  markSupplyPaid,
  markSupplyUnpaid,
  postSupply,
} from '@/lib/api/supplies';
import { queryKeys } from '@/lib/query-keys';
import { invalidateStockViews } from '@/lib/query-invalidation';
import { SupplyEditor } from '@/components/supply-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { StatRow } from '@/components/ui/stat-row';
import { StickyActionBar } from '@/components/ui/sticky-action-bar';
import { userFacingError } from '@/lib/api/error-messages';

export default function SupplyDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const canView = hasPermission(Permission.SUPPLIES_VIEW);
  const canPost = hasPermission(Permission.SUPPLIES_POST);
  const canCorrect = hasPermission(Permission.SUPPLIES_CORRECT);
  const canViewPrice = hasPermission(Permission.PURCHASE_PRICE_VIEW);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  useEffect(() => {
    if (bootstrapped && user && !canView) {
      router.replace('/app');
    }
  }, [bootstrapped, user, canView, router]);

  const query = useQuery({
    queryKey: queryKeys.supply(id),
    queryFn: () => getSupply(id),
    enabled: Boolean(id) && canView,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['supplies'] });
    await invalidateStockViews(queryClient);
    await queryClient.invalidateQueries({ queryKey: queryKeys.supply(id) });
  };

  const postMutation = useMutation({
    mutationFn: () => postSupply(id),
    onSuccess: async () => {
      setMessage('Поставка проведена');
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(userFacingError(err, 'Ошибка проведения')),
  });

  const correctMutation = useMutation({
    mutationFn: () => correctSupply(id, reason.trim()),
    onSuccess: async (created) => {
      await invalidate();
      router.push(`/app/supplies/${created.id}`);
    },
    onError: (err) => setError(userFacingError(err, 'Ошибка коррекции')),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelSupply(id, reason.trim()),
    onSuccess: async () => {
      setMessage('Поставка отменена');
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(userFacingError(err, 'Ошибка отмены')),
  });

  const paidMutation = useMutation({
    mutationFn: (markPaid: boolean) => (markPaid ? markSupplyPaid(id) : markSupplyUnpaid(id)),
    onSuccess: async (supply) => {
      setMessage(supply.isPaid ? 'Отмечена как оплаченная' : 'Оплата снята');
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(userFacingError(err, 'Ошибка изменения оплаты')),
  });

  if (!bootstrapped || !user || !canView) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  if (query.isLoading) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-danger-fg">Поставка не найдена</p>
        <Button type="button" variant="outline" onClick={() => router.push('/app/supplies')}>
          К списку
        </Button>
      </div>
    );
  }

  const supply = query.data;

  if (mode === 'edit' && supply.status === SupplyStatus.DRAFT) {
    return (
      <SupplyEditor
        mode="edit"
        initial={supply}
        title={
          supply.correctionOfNumber != null
            ? `Коррекция поставки П-${String(supply.correctionOfNumber).padStart(6, '0')}`
            : `Черновик ${supply.numberLabel}`
        }
      />
    );
  }

  const headerActions = (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full sm:w-auto"
        onClick={() => router.push('/app/supplies')}
      >
        К списку
      </Button>
      {supply.status === SupplyStatus.DRAFT ? (
        <Button
          type="button"
          variant="soft"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => setMode('edit')}
        >
          Редактировать
        </Button>
      ) : null}
      {supply.status === SupplyStatus.DRAFT && canPost ? (
        <Button
          type="button"
          className="min-h-11 w-full sm:w-auto"
          disabled={postMutation.isPending}
          onClick={() => {
            if (
              typeof window !== 'undefined' &&
              !window.confirm(
                'Провести поставку? После проведения изменить позиции напрямую будет нельзя.',
              )
            ) {
              return;
            }
            postMutation.mutate();
          }}
        >
          Провести
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="min-w-0 space-y-6 pb-28 sm:pb-0">
      <PageHeader
        title={supply.numberLabel}
        description={
          <div>
            <p>
              {SUPPLY_STATUS_LABELS_RU[supply.status]} · {supply.documentDate}
            </p>
            {supply.correctionOfSupplyId ? (
              <p className="mt-2 text-sm">
                Коррекция поставки{' '}
                <Link className="underline" href={`/app/supplies/${supply.correctionOfSupplyId}`}>
                  П-{String(supply.correctionOfNumber).padStart(6, '0')}
                </Link>
              </p>
            ) : null}
            {supply.correctedBySupplyId ? (
              <p className="mt-2 text-sm">
                Исправлена поставкой{' '}
                <Link className="underline" href={`/app/supplies/${supply.correctedBySupplyId}`}>
                  П-{String(supply.correctedByNumber).padStart(6, '0')}
                </Link>
              </p>
            ) : null}
          </div>
        }
        actions={<div className="hidden flex-wrap gap-2 sm:flex">{headerActions}</div>}
      />

      {message ? <p className="text-sm text-success-fg">{message}</p> : null}
      {error ? <p className="text-sm text-danger-fg">{error}</p> : null}

      <section className="grid gap-3 rounded-[28px] border border-border bg-card p-4 text-sm sm:p-6 md:grid-cols-2">
        <div>Поставщик: {supply.supplierName || '—'}</div>
        <div>Комментарий: {supply.comment ?? '—'}</div>
        <div>Крайняя дата оплаты: {supply.paymentDueDate ?? '—'}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Оплата:{' '}
            {supply.status === SupplyStatus.CANCELLED
              ? '—'
              : supply.isPaid
                ? 'Оплачена'
                : 'Не оплачена'}
          </span>
          {supply.status !== SupplyStatus.CANCELLED && canPost ? (
            supply.isPaid ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={paidMutation.isPending}
                onClick={() => paidMutation.mutate(false)}
              >
                Снять оплату
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={paidMutation.isPending}
                onClick={() => paidMutation.mutate(true)}
              >
                Отметить оплаченной
              </Button>
            )
          ) : null}
        </div>
        {supply.isPaid && supply.paidAt ? (
          <div>
            Оплатил: {supply.paidByName ?? '—'} · {new Date(supply.paidAt).toLocaleString('ru-RU')}
          </div>
        ) : null}
        <div>Создал: {supply.createdByName}</div>
        <div>Провёл: {supply.postedByName ?? '—'}</div>
        <div>Позиций: {supply.itemCount}</div>
        <div>Количество: {supply.totalQuantity}</div>
        {canViewPrice ? <div>Сумма: {supply.totalAmount ?? '—'} BYN</div> : null}
      </section>

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <th className="px-5 py-3 font-medium">Товар</th>
                <th className="px-3 py-3 font-medium">Кол-во</th>
                {canViewPrice ? <th className="px-3 py-3 font-medium">Цена</th> : null}
                {canViewPrice ? <th className="px-5 py-3 font-medium">Сумма</th> : null}
              </tr>
            </thead>
            <tbody>
              {supply.items.map((item) => (
                <tr key={item.id} className="border-b border-border/80">
                  <td className="px-5 py-3">{item.productName}</td>
                  <td className="px-3 py-3">{item.quantity}</td>
                  {canViewPrice ? (
                    <td className="px-3 py-3">{item.unitPurchasePrice ?? '—'} BYN</td>
                  ) : null}
                  {canViewPrice ? <td className="px-5 py-3">{item.lineTotal ?? '—'} BYN</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 p-3 md:hidden">
          {supply.items.map((item) => (
            <div key={item.id} className="rounded-2xl border border-border/80 px-4 py-3">
              <p className="text-sm font-medium">{item.productName}</p>
              <div className="mt-2 space-y-1">
                <StatRow label="Кол-во" value={item.quantity} />
                {canViewPrice ? (
                  <StatRow label="Цена" value={`${item.unitPurchasePrice ?? '—'} BYN`} />
                ) : null}
                {canViewPrice ? (
                  <StatRow label="Сумма" emphasize value={`${item.lineTotal ?? '—'} BYN`} />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      {supply.status === SupplyStatus.POSTED && canCorrect ? (
        <section className="space-y-3 rounded-[28px] border border-border bg-card p-4 sm:p-6">
          <h2 className="font-semibold">Исправление / отмена</h2>
          <p className="text-sm text-muted-foreground">
            Доступно только если партии этой поставки ещё не списывались.
          </p>
          <div className="space-y-2">
            <Label htmlFor="correct-reason">Причина *</Label>
            <Input
              id="correct-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={reason.trim().length < 3 || correctMutation.isPending}
              onClick={() => correctMutation.mutate()}
            >
              Исправить
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              disabled={reason.trim().length < 3 || cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              Отменить поставку
            </Button>
          </div>
        </section>
      ) : null}

      <StickyActionBar className="sm:hidden">{headerActions}</StickyActionBar>
    </div>
  );
}
