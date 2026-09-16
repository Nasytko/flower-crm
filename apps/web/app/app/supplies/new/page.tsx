'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { SupplyEditor } from '@/components/supply-editor';
import { useAuth } from '@/lib/auth/auth-context';

export default function NewSupplyPage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.SUPPLIES_CREATE)) {
      router.replace('/app/supplies');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.SUPPLIES_CREATE)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return <SupplyEditor mode="create" title="Новая поставка" />;
}
