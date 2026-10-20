'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkSessionStatusDto } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import {
  getWorkstationStatus,
  lockWorkstation,
  openWorkSession,
  recordUserActivity,
} from '@/lib/api/security';
import { ApiClientError } from '@/lib/api/client';
import { confirmLeaveUnsavedWork } from '@/lib/unsaved-work';
import { WorkstationLockScreen } from '@/components/workstation-lock-screen';

interface WorkstationContextValue {
  status: WorkSessionStatusDto | null;
  locked: boolean;
  lock: () => Promise<void>;
  openWork: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const WorkstationContext = createContext<WorkstationContextValue | null>(null);

export function WorkstationProvider({ children }: { children: ReactNode }): ReactElement {
  const { user, accessToken, applySession, logout } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WorkSessionStatusDto | null>(null);
  const [locked, setLocked] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!accessToken) {
      setStatus(null);
      return;
    }
    try {
      const next = await getWorkstationStatus();
      setStatus(next);
      setLocked(next.locked);
    } catch (err) {
      if (err instanceof ApiClientError && err.body.code === 'WORKSTATION_LOCKED') {
        setLocked(true);
      }
    }
  }, [accessToken]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, user?.id]);

  const resetIdle = useCallback(() => {
    if (!status?.active || locked) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    const minutes = status.idleLockMinutes || 5;
    idleTimer.current = setTimeout(() => {
      void (async () => {
        if (!confirmLeaveUnsavedWork()) {
          resetIdle();
          return;
        }
        try {
          await lockWorkstation();
          setLocked(true);
        } catch {
          // ignore
        }
      })();
    }, minutes * 60 * 1000);
  }, [status?.active, status?.idleLockMinutes, locked]);

  useEffect(() => {
    if (!status?.active || locked) return;
    const onUserGesture = () => {
      resetIdle();
      void recordUserActivity().then((r) => {
        if (r.shouldLock) setLocked(true);
      });
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const ev of events) window.addEventListener(ev, onUserGesture, { passive: true });
    resetIdle();
    return () => {
      for (const ev of events) window.removeEventListener(ev, onUserGesture);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [status?.active, locked, resetIdle]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void refreshStatus();
    };
    const onLocked = () => setLocked(true);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('erp:workstation-locked', onLocked);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel('erp-workstation');
      channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === 'locked') setLocked(true);
        if (event.data?.type === 'unlocked') {
          setLocked(false);
          void refreshStatus();
        }
      };
    } catch {
      // ignore
    }

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('erp:workstation-locked', onLocked);
      channel?.close();
    };
  }, [refreshStatus]);

  const broadcastWorkstation = useCallback((type: 'locked' | 'unlocked') => {
    try {
      const channel = new BroadcastChannel('erp-workstation');
      channel.postMessage({ type });
      channel.close();
    } catch {
      // ignore
    }
  }, []);

  const lock = useCallback(async () => {
    if (!confirmLeaveUnsavedWork()) return;
    await lockWorkstation();
    setLocked(true);
    broadcastWorkstation('locked');
    await refreshStatus();
  }, [refreshStatus, broadcastWorkstation]);

  const openWork = useCallback(async () => {
    const next = await openWorkSession();
    setStatus(next);
    setLocked(false);
  }, []);

  const value = useMemo(
    () => ({ status, locked, lock, openWork, refreshStatus }),
    [status, locked, lock, openWork, refreshStatus],
  );

  return (
    <WorkstationContext.Provider value={value}>
      {children}
      {locked ? (
        <WorkstationLockScreen
          onUnlocked={({ accessToken: token, user: nextUser }) => {
            applySession(token, nextUser);
            void queryClient.clear();
            setLocked(false);
            broadcastWorkstation('unlocked');
            void refreshStatus();
          }}
          onFullLogin={() => {
            void logout();
          }}
        />
      ) : null}
    </WorkstationContext.Provider>
  );
}

export function useWorkstation(): WorkstationContextValue {
  const ctx = useContext(WorkstationContext);
  if (!ctx) throw new Error('useWorkstation must be used within WorkstationProvider');
  return ctx;
}
