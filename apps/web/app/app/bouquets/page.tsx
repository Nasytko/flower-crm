'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { BouquetsPage } from '@/components/bouquets-page';
import { useAuth } from '@/lib/auth/auth-context';

export default function BouquetsRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.BOUQUETS_VIEW)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.BOUQUETS_VIEW)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return <BouquetsPage />;
}
