import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@erp/shared';

export const PERMISSIONS_KEY = 'permissions';

export const RequirePermissions = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);
