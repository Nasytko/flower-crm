'use client';

import type { ReactElement } from 'react';
import { Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { SettingsPage } from '@/components/settings-page';

export default function SettingsRoutePage(): ReactElement {
  const { bootstrapped, hasPermission } = useAuth();
  if (!bootstrapped) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }
  if (!hasPermission(Permission.SETTINGS_MANAGE)) {
    return <div className="text-sm text-muted-foreground">Недостаточно прав</div>;
  }
  return <SettingsPage />;
}
