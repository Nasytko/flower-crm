'use client';

import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { getSystemSettings } from '@/lib/api/settings';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SecuritySettingsPanel } from '@/components/security-settings-panel';
import { cn } from '@/lib/utils';

type SettingsTab = 'system' | 'security';

export function SettingsPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.SETTINGS_MANAGE);
  const canSecurity = hasPermission(Permission.SECURITY_POLICY_MANAGE);
  const [tab, setTab] = useState<SettingsTab>(canSecurity ? 'security' : 'system');

  const query = useQuery({
    queryKey: queryKeys.systemSettings,
    queryFn: getSystemSettings,
    enabled: canManage && tab === 'system',
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
    <div className="min-w-0 max-w-3xl space-y-4">
      <PageHeader
        title="Настройки"
        description="Система и безопасность рабочего места"
        actions={
          tab === 'system' ? (
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              Обновить
            </Button>
          ) : null
        }
      />

      <div className="flex gap-2">
        {canSecurity ? (
          <Button
            type="button"
            variant={tab === 'security' ? 'default' : 'outline'}
            onClick={() => setTab('security')}
          >
            Безопасность и доступ
          </Button>
        ) : null}
        <Button
          type="button"
          variant={tab === 'system' ? 'default' : 'outline'}
          onClick={() => setTab('system')}
        >
          Система
        </Button>
      </div>

      {tab === 'security' && canSecurity ? <SecuritySettingsPanel /> : null}

      {tab === 'system' ? (
        query.isLoading ? (
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
          </section>
        )
      ) : null}
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
