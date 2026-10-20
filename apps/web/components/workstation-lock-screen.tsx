'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS_RU, type AuthUser } from '@erp/shared';
import { listPinCandidates, unlockWithPin } from '@/lib/api/security';
import { Button } from '@/components/ui/button';
import { userFacingError } from '@/lib/api/error-messages';
import { cn } from '@/lib/utils';

export function WorkstationLockScreen({
  onUnlocked,
  onFullLogin,
}: {
  onUnlocked: (payload: { accessToken: string; user: AuthUser }) => void;
  onFullLogin: () => void;
}): ReactElement {
  const candidatesQuery = useQuery({
    queryKey: ['pin-candidates'],
    queryFn: listPinCandidates,
    refetchInterval: 30_000,
  });
  const candidates = candidatesQuery.data ?? [];
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!userId && candidates[0]) setUserId(candidates[0].id);
  }, [candidates, userId]);

  const selected = useMemo(
    () => candidates.find((c) => c.id === userId) ?? null,
    [candidates, userId],
  );

  const submit = async () => {
    if (!userId || pin.length !== 6) {
      setError('Выберите сотрудника и введите 6-значный PIN');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await unlockWithPin({ userId, pin });
      onUnlocked({ accessToken: result.accessToken, user: result.user });
      setPin('');
    } catch (err) {
      setError(userFacingError(err, 'Неверный PIN'));
      setPin('');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[radial-gradient(ellipse_at_top,_#1a2332_0%,_#0b1020_55%,_#070a12_100%)] px-4">
      <div className="w-full max-w-md space-y-6 rounded-[28px] border border-white/10 bg-white/5 p-6 text-white shadow-2xl backdrop-blur-md sm:p-8">
        <div className="space-y-1 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
            Букет №1
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Рабочее место заблокировано</h1>
          <p className="text-sm text-white/60">Выберите сотрудника и введите PIN</p>
        </div>

        {candidatesQuery.isLoading ? (
          <p className="text-center text-sm text-white/50">Загрузка…</p>
        ) : candidates.length === 0 ? (
          <p className="rounded-2xl bg-white/5 px-4 py-3 text-center text-sm text-white/70">
            PIN-вход недоступен. Откройте рабочую сессию на доверенном устройстве или войдите по
            паролю.
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs text-white/50">Сотрудник</label>
            <div className="grid gap-2">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setUserId(c.id)}
                  className={cn(
                    'flex min-h-11 items-center justify-between rounded-2xl border px-4 text-left text-sm transition',
                    userId === c.id
                      ? 'border-white/40 bg-white/15'
                      : 'border-white/10 bg-white/5 hover:bg-white/10',
                  )}
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-white/50">{ROLE_LABELS_RU[c.role]}</span>
                </button>
              ))}
            </div>

            <label className="block text-xs text-white/50">PIN</label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              className="h-12 w-full rounded-2xl border border-white/15 bg-black/30 px-4 text-center text-2xl tracking-[0.4em] outline-none focus:ring-2 focus:ring-white/30"
              placeholder="••••••"
              aria-label="PIN"
            />

            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map((key) => (
                <button
                  key={key}
                  type="button"
                  className="min-h-12 rounded-2xl bg-white/10 text-lg font-medium hover:bg-white/20 active:scale-[0.98]"
                  onClick={() => {
                    if (key === '⌫') setPin((p) => p.slice(0, -1));
                    else if (key === 'OK') void submit();
                    else if (pin.length < 6) setPin((p) => p + key);
                  }}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>
        )}

        {error ? <p className="text-center text-sm text-red-300">{error}</p> : null}
        {selected ? (
          <p className="text-center text-xs text-white/40">Вход как {selected.name}</p>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            className="min-h-11"
            disabled={pending || candidates.length === 0}
            onClick={() => void submit()}
          >
            Разблокировать
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-white/20 bg-transparent text-white hover:bg-white/10"
            onClick={onFullLogin}
          >
            Полный вход по паролю
          </Button>
        </div>
      </div>
    </div>
  );
}
