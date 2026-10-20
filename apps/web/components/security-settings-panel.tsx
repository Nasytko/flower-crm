'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DeviceAccessMode,
  Permission,
  SECURITY_POLICY_LIMITS,
  type EmployeeListItem,
  type SecurityPolicyDto,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { listEmployees } from '@/lib/api/employees';
import {
  extendTrustedDevice,
  forceLockDevice,
  getSecurityPolicy,
  listTrustedDevices,
  revokeTrustedDevice,
  stepUpPassword,
  trustCurrentDevice,
  updateSecurityPolicy,
  updateTrustedDevice,
} from '@/lib/api/security';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FilterSelect } from '@/components/ui/searchable-select';
import { userFacingError } from '@/lib/api/error-messages';
import { ApiClientError } from '@/lib/api/client';

async function withStepUp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiClientError && err.body.code === 'STEP_UP_REQUIRED') {
      const password = window.prompt('Подтвердите пароль директора для продолжения');
      if (!password) throw err;
      await stepUpPassword(password);
      return await run();
    }
    throw err;
  }
}

export function SecuritySettingsPanel(): ReactElement {
  const { hasPermission } = useAuth();
  const can = hasPermission(Permission.SECURITY_POLICY_MANAGE);
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const policyQuery = useQuery({
    queryKey: ['security-policy'],
    queryFn: getSecurityPolicy,
    enabled: can,
  });
  const devicesQuery = useQuery({
    queryKey: ['trusted-devices'],
    queryFn: listTrustedDevices,
    enabled: can,
  });
  const employeesQuery = useQuery({
    queryKey: queryKeys.employees,
    queryFn: listEmployees,
    enabled: can,
  });

  const [draft, setDraft] = useState<Partial<SecurityPolicyDto>>({});
  const policy = policyQuery.data;
  const merged = useMemo(() => ({ ...policy, ...draft }), [policy, draft]);

  const savePolicy = useMutation({
    mutationFn: () => withStepUp(() => updateSecurityPolicy(draft)),
    onSuccess: async () => {
      setDraft({});
      setMessage('Политика сохранена');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['security-policy'] });
    },
    onError: (err) => setError(userFacingError(err, 'Ошибка сохранения')),
  });

  const [deviceName, setDeviceName] = useState('Касса — основной компьютер');
  const [accessMode, setAccessMode] = useState<DeviceAccessMode>(DeviceAccessMode.ALL_PIN_USERS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const trustMutation = useMutation({
    mutationFn: () =>
      withStepUp(() =>
        trustCurrentDevice({
          name: deviceName,
          accessMode,
          allowedUserIds: accessMode === DeviceAccessMode.SELECTED_USERS ? selectedIds : undefined,
        }),
      ),
    onSuccess: async () => {
      setMessage('Устройство зарегистрировано');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['trusted-devices'] });
    },
    onError: (err) => setError(userFacingError(err, 'Ошибка регистрации')),
  });

  if (!can) {
    return (
      <p className="text-sm text-muted-foreground">
        Недостаточно прав для управления безопасностью.
      </p>
    );
  }

  const employees = (employeesQuery.data ?? []) as EmployeeListItem[];

  return (
    <div className="space-y-6">
      {message ? (
        <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h3 className="text-base font-semibold">Общие настройки</h3>
        {!policy ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle
              label="Разрешить PIN-вход в организации"
              checked={Boolean(merged.pinEnabledOrg)}
              onChange={(v) => setDraft((d) => ({ ...d, pinEnabledOrg: v }))}
            />
            <Toggle
              label="Переключение сотрудников по PIN"
              checked={Boolean(merged.allowEmployeeSwitch)}
              onChange={(v) => setDraft((d) => ({ ...d, allowEmployeeSwitch: v }))}
            />
            <NumberField
              label="Срок доверия к устройству (дней)"
              value={merged.deviceTrustDays ?? 30}
              min={SECURITY_POLICY_LIMITS.deviceTrustDays.min}
              max={SECURITY_POLICY_LIMITS.deviceTrustDays.max}
              onChange={(v) => setDraft((d) => ({ ...d, deviceTrustDays: v }))}
            />
            <NumberField
              label="Рабочая сессия (часов)"
              value={merged.workSessionMaxHours ?? 12}
              min={SECURITY_POLICY_LIMITS.workSessionMaxHours.min}
              max={SECURITY_POLICY_LIMITS.workSessionMaxHours.max}
              onChange={(v) => setDraft((d) => ({ ...d, workSessionMaxHours: v }))}
            />
            <NumberField
              label="Автоблокировка (минут)"
              value={merged.idleLockMinutes ?? 5}
              min={SECURITY_POLICY_LIMITS.idleLockMinutes.min}
              max={SECURITY_POLICY_LIMITS.idleLockMinutes.max}
              onChange={(v) => setDraft((d) => ({ ...d, idleLockMinutes: v }))}
            />
            <NumberField
              label="Макс. попыток PIN"
              value={merged.pinMaxAttempts ?? 5}
              min={SECURITY_POLICY_LIMITS.pinMaxAttempts.min}
              max={SECURITY_POLICY_LIMITS.pinMaxAttempts.max}
              onChange={(v) => setDraft((d) => ({ ...d, pinMaxAttempts: v }))}
            />
            <NumberField
              label="Блокировка после попыток (мин)"
              value={merged.pinLockoutMinutes ?? 15}
              min={SECURITY_POLICY_LIMITS.pinLockoutMinutes.min}
              max={SECURITY_POLICY_LIMITS.pinLockoutMinutes.max}
              onChange={(v) => setDraft((d) => ({ ...d, pinLockoutMinutes: v }))}
            />
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Длина PIN фиксирована: 6 цифр. Открыть рабочую сессию можно только после входа по
              паролю.
            </p>
            <Button
              type="button"
              disabled={savePolicy.isPending || Object.keys(draft).length === 0}
              onClick={() => savePolicy.mutate()}
            >
              Сохранить политику
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h3 className="text-base font-semibold">Доверенные устройства</h3>
        <div className="space-y-3 rounded-2xl border border-dashed border-border p-4">
          <Label>Сделать это устройство доверенным</Label>
          <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
          <FilterSelect
            ariaLabel="Режим доступа"
            value={accessMode}
            onChange={(v) => setAccessMode(v as DeviceAccessMode)}
            options={[
              { value: DeviceAccessMode.ALL_PIN_USERS, label: 'Все сотрудники с PIN' },
              { value: DeviceAccessMode.SELECTED_USERS, label: 'Только выбранные' },
            ]}
          />
          {accessMode === DeviceAccessMode.SELECTED_USERS ? (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
              {employees
                .filter((e) => e.isActive)
                .map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(e.id)}
                      onChange={(ev) => {
                        setSelectedIds((ids) =>
                          ev.target.checked ? [...ids, e.id] : ids.filter((id) => id !== e.id),
                        );
                      }}
                    />
                    {e.name}
                  </label>
                ))}
            </div>
          ) : null}
          <Button
            type="button"
            disabled={trustMutation.isPending}
            onClick={() => trustMutation.mutate()}
          >
            Зарегистрировать это устройство
          </Button>
        </div>

        <div className="space-y-2">
          {(devicesQuery.data ?? []).map((d) => (
            <div
              key={d.id}
              className="flex flex-col gap-2 rounded-2xl border border-border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium">
                  {d.name}{' '}
                  {d.isCurrentDevice ? (
                    <span className="text-xs text-muted-foreground">(это устройство)</span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.status} · до {new Date(d.expiresAt).toLocaleString('ru-RU')} ·{' '}
                  {d.accessMode === DeviceAccessMode.ALL_PIN_USERS
                    ? 'все с PIN'
                    : `выбрано: ${d.allowedUserIds.length}`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void withStepUp(() => extendTrustedDevice(d.id))
                      .then(async () => {
                        setMessage('Срок доверия продлён');
                        await qc.invalidateQueries({ queryKey: ['trusted-devices'] });
                      })
                      .catch((err) => setError(userFacingError(err, 'Ошибка')))
                  }
                >
                  Продлить
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void withStepUp(() => forceLockDevice(d.id))
                      .then(() => setMessage('Устройство принудительно заблокировано'))
                      .catch((err) => setError(userFacingError(err, 'Ошибка')))
                  }
                >
                  Заблокировать
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const name = window.prompt('Новое название', d.name);
                    if (!name) return;
                    void withStepUp(() => updateTrustedDevice(d.id, { name }))
                      .then(async () => {
                        await qc.invalidateQueries({ queryKey: ['trusted-devices'] });
                      })
                      .catch((err) => setError(userFacingError(err, 'Ошибка')));
                  }}
                >
                  Имя
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-danger-fg"
                  onClick={() =>
                    void withStepUp(() => revokeTrustedDevice(d.id))
                      .then(async () => {
                        setMessage('Доверие отозвано');
                        await qc.invalidateQueries({ queryKey: ['trusted-devices'] });
                      })
                      .catch((err) => setError(userFacingError(err, 'Ошибка')))
                  }
                >
                  Отозвать
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-[28px] border border-border bg-card p-5">
        <h3 className="text-base font-semibold">PIN сотрудников</h3>
        <p className="text-sm text-muted-foreground">
          Генерация и сброс PIN — в карточке сотрудника (раздел «Сотрудники»). Здесь — сводка
          статусов.
        </p>
        <div className="space-y-1">
          {employees.map((e) => (
            <div key={e.id} className="flex justify-between border-b border-border/60 py-2 text-sm">
              <span>{e.name}</span>
              <span className="text-muted-foreground">{e.pinStatus ?? '—'}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): ReactElement {
  return (
    <label className="flex items-center justify-between gap-3 rounded-2xl border border-border px-3 py-2 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}): ReactElement {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
