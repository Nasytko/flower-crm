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
import type { QueryClient } from '@tanstack/react-query';
import type { AuthUser, Permission } from '@erp/shared';
import { configureApiClient } from '@/lib/api/client';
import { loginRequest, logoutRequest, refreshRequest } from '@/lib/api/auth';

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  bootstrapped: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}): ReactElement {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const tokenRef = useRef<string | null>(null);

  const setAccessToken = useCallback((token: string | null) => {
    tokenRef.current = token;
    setAccessTokenState(token);
  }, []);

  const clearAuth = useCallback(() => {
    tokenRef.current = null;
    setAccessTokenState(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    configureApiClient({
      getAccessToken: () => tokenRef.current,
      setAccessToken,
      onUnauthorized: clearAuth,
    });
  }, [setAccessToken, clearAuth]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const refreshed = await refreshRequest();
        if (cancelled) return;
        setAccessToken(refreshed.accessToken);
        setUser(refreshed.user);
      } catch {
        if (!cancelled) {
          clearAuth();
        }
      } finally {
        if (!cancelled) {
          setBootstrapped(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearAuth, setAccessToken]);

  const login = useCallback(
    async (loginValue: string, password: string) => {
      queryClient.clear();
      const result = await loginRequest(loginValue, password);
      setAccessToken(result.accessToken);
      setUser(result.user);
    },
    [queryClient, setAccessToken],
  );

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      bootstrapped,
      login,
      logout,
      hasPermission: (permission: Permission) => user?.permissions.includes(permission) ?? false,
    }),
    [user, accessToken, bootstrapped, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
