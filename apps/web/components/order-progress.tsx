'use client';

import type { ReactElement } from 'react';
import {
  ORDER_PAYMENT_STATUS_LABELS_RU,
  PAYMENT_METHOD_LABELS_RU,
  type OrderDetail,
  type PaymentDto,
} from '@erp/shared';
import { cn } from '@/lib/utils';

function ProgressBar({
  percent,
  label,
  tone = 'primary',
}: {
  percent: number;
  label: string;
  tone?: 'primary' | 'success' | 'warn';
}): ReactElement {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{clamped}%</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            tone === 'success' && 'bg-success-fg',
            tone === 'warn' && 'bg-warn-fg',
            tone === 'primary' && 'bg-foreground',
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function StageStrip({
  stages,
}: {
  stages: OrderDetail['fulfillmentProgress']['stages'];
}): ReactElement {
  return (
    <ol className="flex flex-wrap gap-2">
      {stages.map((s) => (
        <li
          key={s.id}
          className={cn(
            'rounded-2xl border px-3 py-1.5 text-xs',
            s.state === 'done' && 'border-success-fg/30 bg-success-soft text-success-fg',
            s.state === 'current' && 'border-foreground bg-foreground text-background',
            s.state === 'pending' && 'border-border bg-muted/40 text-muted-foreground',
            s.state === 'skipped' && 'border-transparent text-muted-foreground/60 line-through',
          )}
          title={s.hint ?? undefined}
        >
          {s.label}
          {s.hint ? <span className="ml-1 opacity-80">· {s.hint}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function PaymentList({ payments }: { payments: PaymentDto[] }): ReactElement | null {
  if (payments.length === 0) return null;
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border">
      {payments.map((p) => (
        <li
          key={p.id}
          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
        >
          <div>
            <p className="font-medium">
              {p.kind === 'REFUND' ? 'Возврат' : 'Оплата'} · {PAYMENT_METHOD_LABELS_RU[p.method]}
              {p.isManual ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">(вручную)</span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {p.status} · {new Date(p.createdAt).toLocaleString('ru-RU')} · {p.createdByName}
            </p>
          </div>
          <p className="tabular-nums font-medium">
            {p.amount} {p.currency}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function OrderProgress({ order }: { order: OrderDetail }): ReactElement {
  const pay = order.paymentSummary;
  const prog = order.fulfillmentProgress;
  const fulfillmentPercent =
    order.status === 'COMPLETED'
      ? 100
      : order.status === 'READY'
        ? 75
        : order.status === 'IN_PROGRESS'
          ? 40
          : order.status === 'CANCELLED'
            ? 0
            : 10;

  const payTone =
    pay.paymentProgressPercent >= 100
      ? 'success'
      : pay.paymentProgressPercent > 0
        ? 'warn'
        : 'primary';

  return (
    <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <header>
        <h2 className="text-sm font-semibold">Прогресс заказа</h2>
        {prog.nextAction ? (
          <p className="mt-1 text-sm text-muted-foreground">Далее: {prog.nextAction}</p>
        ) : null}
      </header>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Выполнение
        </p>
        <StageStrip stages={prog.stages} />
        <ProgressBar percent={fulfillmentPercent} label="Готовность" tone="primary" />
        {prog.bouquetRequiredCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Букеты: {prog.bouquetAssembledCount} из {prog.bouquetRequiredCount} собрано
            {prog.productRequiredCount > 0
              ? ` · товары: ${prog.productIssuedCount} из ${prog.productRequiredCount} выдано`
              : null}
          </p>
        ) : prog.productRequiredCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Товары / услуги: {prog.productIssuedCount} из {prog.productRequiredCount} выдано
          </p>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Оплата
        </p>
        <ProgressBar
          percent={pay.paymentProgressPercent}
          label={`${ORDER_PAYMENT_STATUS_LABELS_RU[pay.paymentStatus]} · ${pay.netPaid} / ${pay.orderTotal} BYN`}
          tone={payTone}
        />
        <p className="text-xs text-muted-foreground">
          Остаток к оплате: {pay.remainingDue} BYN
          {Number(pay.pendingAmount) > 0 ? ` · ожидает подтверждения: ${pay.pendingAmount}` : null}
          {Number(pay.confirmedRefunded) > 0 ? ` · возвращено: ${pay.confirmedRefunded}` : null}
        </p>
        <PaymentList payments={order.payments} />
      </div>
    </section>
  );
}
