import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { AuthStrength, Role } from '@erp/shared';
import { AuthGuard } from './auth.guard';
import { ALLOW_LOCKED_KEY } from './allow-locked.decorator';
import { REQUIRE_ELEVATION_KEY } from './require-elevation.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthenticatedUser } from './auth.types';

function mockContext(headers: Record<string, string> = {}): ExecutionContext & {
  request: { headers: Record<string, string>; user?: AuthenticatedUser };
} {
  const request: { headers: Record<string, string>; user?: AuthenticatedUser } = { headers };
  return {
    request,
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as never;
}

describe('AuthGuard workstation lock & elevation', () => {
  const sessions = {
    resolveAuthenticatedUser: jest.fn(),
  };
  const workstation = {
    enforceIdleLockIfNeeded: jest.fn().mockResolvedValue(false),
  };
  const moduleRef = {
    get: jest.fn().mockReturnValue(workstation),
  };
  const reflector = new Reflector();
  const guard = new AuthGuard(reflector, sessions as never, moduleRef as unknown as ModuleRef);

  const baseUser: AuthenticatedUser = {
    id: 'u1',
    name: 'User',
    login: 'user',
    role: Role.FLORIST,
    sessionId: 's1',
    isActive: true,
    authStrength: AuthStrength.PIN,
    elevatedUntil: null,
    workSessionId: 'w1',
    lockedAt: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workstation.enforceIdleLockIfNeeded.mockResolvedValue(false);
    moduleRef.get.mockReturnValue(workstation);
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === ALLOW_LOCKED_KEY) return false;
      if (key === REQUIRE_ELEVATION_KEY) return false;
      return undefined;
    });
  });

  it('allows public routes without token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return true;
      return false;
    });
    await expect(guard.canActivate(mockContext())).resolves.toBe(true);
    expect(sessions.resolveAuthenticatedUser).not.toHaveBeenCalled();
    expect(workstation.enforceIdleLockIfNeeded).not.toHaveBeenCalled();
  });

  it('blocks protected APIs when workstation is locked', async () => {
    sessions.resolveAuthenticatedUser.mockResolvedValue({
      ...baseUser,
      lockedAt: new Date(),
    });
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'WORKSTATION_LOCKED',
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  });

  it('locks and rejects when idle timeout exceeded on protected API', async () => {
    sessions.resolveAuthenticatedUser.mockResolvedValue({ ...baseUser });
    workstation.enforceIdleLockIfNeeded.mockResolvedValue(true);
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'WORKSTATION_LOCKED',
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
    expect(workstation.enforceIdleLockIfNeeded).toHaveBeenCalled();
  });

  it('does not run idle enforcement on @AllowLocked endpoints', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === ALLOW_LOCKED_KEY) return true;
      if (key === REQUIRE_ELEVATION_KEY) return false;
      return undefined;
    });
    sessions.resolveAuthenticatedUser.mockResolvedValue({
      ...baseUser,
      lockedAt: new Date(),
    });
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(workstation.enforceIdleLockIfNeeded).not.toHaveBeenCalled();
  });

  it('allows @AllowLocked endpoints when locked', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === ALLOW_LOCKED_KEY) return true;
      if (key === REQUIRE_ELEVATION_KEY) return false;
      return undefined;
    });
    sessions.resolveAuthenticatedUser.mockResolvedValue({
      ...baseUser,
      lockedAt: new Date(),
    });
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(ctx.request.user?.lockedAt).toBeTruthy();
  });

  it('requires elevation when @RequireElevation is set', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === REQUIRE_ELEVATION_KEY) return true;
      return false;
    });
    sessions.resolveAuthenticatedUser.mockResolvedValue({
      ...baseUser,
      authStrength: AuthStrength.PIN,
      elevatedUntil: null,
    });
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it('allows elevated PIN session after password step-up window', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === REQUIRE_ELEVATION_KEY) return true;
      return false;
    });
    sessions.resolveAuthenticatedUser.mockResolvedValue({
      ...baseUser,
      authStrength: AuthStrength.PIN,
      elevatedUntil: new Date(Date.now() + 60_000),
    });
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('skips idle enforcement when there is no work session (password-only login)', async () => {
    sessions.resolveAuthenticatedUser.mockResolvedValue({
      ...baseUser,
      workSessionId: null,
    });
    const ctx = mockContext({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(workstation.enforceIdleLockIfNeeded).not.toHaveBeenCalled();
  });
});
