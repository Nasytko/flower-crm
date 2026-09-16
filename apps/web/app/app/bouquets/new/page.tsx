'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { BouquetEditor } from '@/components/bouquet-editor';
import { useAuth } from '@/lib/auth/auth-context';

export default function NewBouquetRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.BOUQUETS_MANAGE)) {
      router.replace('/app/bouquets');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.BOUQUETS_MANAGE)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return <BouquetEditor mode="create" />;
}
