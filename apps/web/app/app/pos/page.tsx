'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { PosPage } from '@/components/pos-page';
import { useAuth } from '@/lib/auth/auth-context';

export default function PosRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.POS_ACCESS)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.POS_ACCESS)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return <PosPage />;
}
