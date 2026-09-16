'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';

export default function HomePage(): ReactElement {
  const router = useRouter();
  const { user, bootstrapped } = useAuth();

  useEffect(() => {
    if (!bootstrapped) return;
    router.replace(user ? '/app' : '/login');
  }, [bootstrapped, user, router]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Загрузка...
    </div>
  );
}
