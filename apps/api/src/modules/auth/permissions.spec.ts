import { Permission, Role, roleHasAllPermissions } from '@erp/shared';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { AUTHENTICATED_ONLY_KEY } from '../../common/auth/authenticated.decorator';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';
import { PERMISSIONS_KEY } from '../../common/auth/require-permissions.decorator';

describe('permissions matrix', () => {
  it('gives DIRECTOR every permission', () => {
    for (const permission of Object.values(Permission)) {
      expect(roleHasPermissionSafe(Role.DIRECTOR, permission)).toBe(true);
    }
  });

  it('denies employees.manage to FLORIST and MANAGER', () => {
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.EMPLOYEES_MANAGE)).toBe(false);
    expect(roleHasPermissionSafe(Role.MANAGER, Permission.EMPLOYEES_MANAGE)).toBe(false);
    expect(roleHasPermissionSafe(Role.DIRECTOR, Permission.EMPLOYEES_MANAGE)).toBe(true);
  });

  it('Phase 5: florist can count inventory but not manage or write-off', () => {
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.INVENTORY_VIEW)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.INVENTORY_COUNT)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.INVENTORY_MANAGE)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.INVENTORY_ADJUST)).toBe(false);
  });

  it('Phase 5: manager can manage inventory and write-off', () => {
    expect(
      roleHasAllPermissions(Role.MANAGER, [
        Permission.INVENTORY_VIEW,
        Permission.INVENTORY_COUNT,
        Permission.INVENTORY_MANAGE,
        Permission.INVENTORY_ADJUST,
      ]),
    ).toBe(true);
  });

  it('Phase 6: florist can view bouquets but not manage or see purchase cost', () => {
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.BOUQUETS_VIEW)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.BOUQUETS_MANAGE)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.PURCHASE_PRICE_VIEW)).toBe(false);
    expect(roleHasPermissionSafe(Role.MANAGER, Permission.BOUQUETS_MANAGE)).toBe(true);
  });

  it('Phase 4: florist cannot manage supplies, write-off, or see purchase cost', () => {
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.PRODUCTS_VIEW)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.INVENTORY_VIEW)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.INVENTORY_ADJUST)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.SUPPLIES_VIEW)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.SUPPLIES_CREATE)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.SUPPLIES_POST)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.PURCHASE_PRICE_VIEW)).toBe(false);
  });

  it('Phase 4: manager can supply and write-off', () => {
    expect(
      roleHasAllPermissions(Role.MANAGER, [
        Permission.PRODUCTS_MANAGE,
        Permission.INVENTORY_ADJUST,
        Permission.SUPPLIES_VIEW,
        Permission.SUPPLIES_CREATE,
        Permission.SUPPLIES_POST,
        Permission.SUPPLIES_CORRECT,
        Permission.PURCHASE_PRICE_VIEW,
      ]),
    ).toBe(true);
  });

  it('Phase 7: florist can operate orders but not cancel or discount', () => {
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.ORDERS_VIEW)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.ORDERS_CREATE)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.ORDERS_UPDATE)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.ORDERS_STATUS)).toBe(true);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.ORDERS_CANCEL)).toBe(false);
    expect(roleHasPermissionSafe(Role.FLORIST, Permission.ORDERS_DISCOUNT)).toBe(false);
    expect(roleHasPermissionSafe(Role.MANAGER, Permission.ORDERS_CANCEL)).toBe(true);
    expect(roleHasPermissionSafe(Role.MANAGER, Permission.ORDERS_DISCOUNT)).toBe(true);
  });
});

function roleHasPermissionSafe(role: Role, permission: Permission): boolean {
  return roleHasAllPermissions(role, [permission]);
}

describe('PermissionsGuard', () => {
  const metadata = new Map<string, unknown>();
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => metadata.get(key)),
  };
  const guard = new PermissionsGuard(reflector as unknown as Reflector);

  beforeEach(() => {
    metadata.clear();
  });

  function contextWithUser(user: unknown): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  const managerUser = {
    role: Role.MANAGER,
    id: '1',
    sessionId: 's',
    name: 'M',
    login: 'm',
    isActive: true,
  };

  it('allows public endpoints without user', () => {
    metadata.set(IS_PUBLIC_KEY, true);
    expect(guard.canActivate(contextWithUser(undefined))).toBe(true);
  });

  it('allows when all required permissions are present', () => {
    metadata.set(PERMISSIONS_KEY, [Permission.EMPLOYEES_VIEW]);
    expect(guard.canActivate(contextWithUser(managerUser))).toBe(true);
  });

  it('allows @Authenticated endpoints for any logged-in user', () => {
    metadata.set(AUTHENTICATED_ONLY_KEY, true);
    expect(guard.canActivate(contextWithUser(managerUser))).toBe(true);
  });

  it('forbids when a required permission is missing', () => {
    metadata.set(PERMISSIONS_KEY, [Permission.EMPLOYEES_MANAGE]);
    expect(() => guard.canActivate(contextWithUser(managerUser))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', httpStatus: HttpStatus.FORBIDDEN }),
    );
  });

  it('requires authentication when permissions are configured', () => {
    metadata.set(PERMISSIONS_KEY, [Permission.EMPLOYEES_VIEW]);
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });

  it('fails closed when neither permissions nor @Authenticated are declared', () => {
    expect(() => guard.canActivate(contextWithUser(managerUser))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
