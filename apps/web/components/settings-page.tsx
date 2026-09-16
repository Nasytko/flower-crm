'use client';

import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { getSystemSettings } from '@/lib/api/settings';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';

export function SettingsPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.SETTINGS_MANAGE);

  const query = useQuery({
    queryKey: queryKeys.systemSettings,
    queryFn: getSystemSettings,
    enabled: canManage,
    refetchInterval: 30_000,
  });

  if (!canManage) {
    return (
      <div className="rounded-[28px] border border-border bg-card p-8 text-sm text-muted-foreground">
        Недостаточно прав для просмотра настроек системы.
      </div>
    );
  }

  const data = query.data;

  return (
    <div className="min-w-0 max-w-2xl space-y-4">
      <PageHeader
        title="Настройки системы"
        description="Статус окружения и рабочие параметры"
        actions={
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Обновить
          </Button>
        }
      />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      ) : query.isError || !data ? (
        <p className="text-sm text-danger-fg">Не удалось получить статус системы</p>
      ) : (
        <section className="space-y-3 rounded-[28px] border border-border bg-card p-5 sm:p-6">
          <StatusRow
            label="API"
            value={data.health.status === 'ok' ? 'Работает' : 'Сбои'}
            ok={data.health.status === 'ok'}
          />
          <StatusRow
            label="База данных"
            value={data.health.database === 'up' ? 'Доступна' : 'Недоступна'}
            ok={data.health.database === 'up'}
          />
          <StatusRow label="Часовой пояс бизнеса" value={data.businessTimeZone} />
          <StatusRow
            label="Режим"
            value={data.nodeEnv === 'production' ? 'Production' : 'Development'}
          />
          <StatusRow label="URL веб-приложения" value={data.webUrl} />
          <StatusRow label="API prefix" value={data.apiPrefix} />
          <p className="pt-2 text-xs text-muted-foreground">
            Изменяемые бизнес-параметры (цены, скидки, роли) живут в соответствующих разделах. Здесь
            только диагностика и системный контекст.
          </p>
        </section>
      )}
    </div>
  );
}

function StatusRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 pb-3 last:border-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-right text-sm font-medium',
          ok === true && 'text-success-fg',
          ok === false && 'text-danger-fg',
        )}
      >
        {value}
      </span>
    </div>
  );
}
