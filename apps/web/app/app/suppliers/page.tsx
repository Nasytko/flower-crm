'use client';

import type { ReactElement } from 'react';
import { Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { SuppliersPage } from '@/components/suppliers-page';

export default function SuppliersRoutePage(): ReactElement {
  const { bootstrapped, hasPermission } = useAuth();
  if (!bootstrapped) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }
  if (!hasPermission(Permission.SUPPLIES_VIEW)) {
    return <div className="text-sm text-muted-foreground">Недостаточно прав</div>;
  }
  return <SuppliersPage />;
}
