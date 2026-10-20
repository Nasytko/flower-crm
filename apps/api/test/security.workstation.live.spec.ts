import { createPrismaClient } from '@erp/database';
import { AuthStrength, DeviceAccessMode, Role } from '@erp/shared';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { AuthGuard } from '../src/common/auth/auth.guard';
import { ALLOW_LOCKED_KEY } from '../src/common/auth/allow-locked.decorator';
import { IS_PUBLIC_KEY } from '../src/common/auth/public.decorator';
import { REQUIRE_ELEVATION_KEY } from '../src/common/auth/require-elevation.decorator';
import type { AuthenticatedUser } from '../src/common/auth/auth.types';
import { hashPassword } from '../src/common/security/password';
import { generateOpaqueToken, hashToken } from '../src/common/security/tokens';
import { AuditService } from '../src/modules/audit/audit.service';
import { SessionService } from '../src/modules/auth/session.service';
import { SecurityPolicyService } from '../src/modules/security/security-policy.service';
import { TrustedDeviceService } from '../src/modules/security/trusted-device.service';
import { WorkstationService } from '../src/modules/security/workstation.service';
import { hashPin } from '../src/modules/security/pin.util';

describe('Workstation PIN security (live DB)', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    it.skip('DATABASE_URL is not set', () => undefined);
    return;
  }

  const prisma = createPrismaClient(databaseUrl);
  const config = {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? 'local-dev-access-secret-change-me-32chars',
    jwtAccessTtlSeconds: 900,
    sessionTtlSeconds: 1209600,
    authCookieName: 'erp_refresh',
    isProduction: false,
  };

  const audit = new AuditService(prisma as never);
  const sessions = new SessionService(prisma as never, config as never);
  const policy = new SecurityPolicyService(prisma as never, audit);
  const devices = new TrustedDeviceService(prisma as never, audit, policy, config as never);
  const workstation = new WorkstationService(prisma as never, audit, sessions, policy, devices);

  const suffix = Date.now().toString(36);
  const ids = {
    director: '',
    florist: '',
    manager: '',
    device: '',
    work: '',
  };
  let deviceRaw = '';
  let ready = false;
  const pinFlorist = '123456';
  const pinManager = '654321';

  const cookieResponse = () => {
    const cookies: string[] = [];
    return {
      cookie: (name: string, value: string) => {
        cookies.push(`${name}=${value}`);
      },
      clearCookie: () => undefined,
      _cookies: cookies,
    } as unknown as Response & { _cookies: string[] };
  };

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.securityPolicy.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    } catch (err) {
      console.warn(
        '[security.workstation.live] NOT RUN: no reachable non-production PostgreSQL (do not use production ERP DB).',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const passwordHash = await hashPassword('LiveTest123!');
    const floristHash = await hashPin(pinFlorist);
    const managerHash = await hashPin(pinManager);

    const director = await prisma.user.create({
      data: {
        login: `ws_dir_${suffix}`,
        name: 'WS Director',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    const florist = await prisma.user.create({
      data: {
        login: `ws_fl_${suffix}`,
        name: 'WS Florist',
        role: Role.FLORIST,
        passwordHash,
        pinEnabled: true,
        pinHash: floristHash,
        pinUpdatedAt: new Date(),
      },
    });
    const manager = await prisma.user.create({
      data: {
        login: `ws_mgr_${suffix}`,
        name: 'WS Manager',
        role: Role.MANAGER,
        passwordHash,
        pinEnabled: true,
        pinHash: managerHash,
        pinUpdatedAt: new Date(),
      },
    });
    ids.director = director.id;
    ids.florist = florist.id;
    ids.manager = manager.id;

    deviceRaw = generateOpaqueToken(32);
    const device = await prisma.trustedDevice.create({
      data: {
        name: `WS Device ${suffix}`,
        tokenHash: hashToken(deviceRaw),
        accessMode: DeviceAccessMode.ALL_PIN_USERS,
        createdByUserId: director.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(),
      },
    });
    ids.device = device.id;
    ready = true;
  }, 120_000);

  afterAll(async () => {
    try {
      if (!ready) return;
      if (ids.device) {
        await prisma.session.deleteMany({
          where: {
            OR: [{ userId: ids.director }, { userId: ids.florist }, { userId: ids.manager }],
          },
        });
        await prisma.workSession.deleteMany({ where: { deviceId: ids.device } });
        await prisma.trustedDevice.deleteMany({ where: { id: ids.device } });
      }
      for (const userId of [ids.director, ids.florist, ids.manager].filter(Boolean)) {
        await prisma.auditLog.deleteMany({
          where: { OR: [{ entityId: userId }, { actorUserId: userId }] },
        });
        await prisma.session.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      await prisma.securityPolicy
        .update({
          where: { id: 1 },
          data: { allowEmployeeSwitch: true, pinMaxAttempts: 5 },
        })
        .catch(() => undefined);
    } finally {
      await prisma.$disconnect();
    }
  });

  async function openDirectorWorkSession(): Promise<{
    actor: AuthenticatedUser;
    accessToken: string;
    refreshToken: string;
  }> {
    const director = await prisma.user.findUniqueOrThrow({ where: { id: ids.director } });
    const created = await sessions.createSession(
      {
        id: director.id,
        name: director.name,
        login: director.login,
        role: Role.DIRECTOR,
      },
      {},
      { authStrength: AuthStrength.PASSWORD },
    );
    const actor: AuthenticatedUser = {
      id: director.id,
      name: director.name,
      login: director.login,
      role: Role.DIRECTOR,
      sessionId: created.sessionId,
      isActive: true,
      authStrength: AuthStrength.PASSWORD,
      elevatedUntil: new Date(Date.now() + 15 * 60 * 1000),
      workSessionId: null,
      lockedAt: null,
    };
    const status = await workstation.openWorkSession(actor, deviceRaw, {});
    ids.work = status.workSessionId!;
    return {
      actor: { ...actor, workSessionId: status.workSessionId, lockedAt: null },
      accessToken: created.accessToken,
      refreshToken: created.refreshToken,
    };
  }

  function mockHttp(token: string, allowLocked = false, requireElevation = false) {
    const request: { headers: Record<string, string>; user?: AuthenticatedUser } = {
      headers: { authorization: `Bearer ${token}` },
    };
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === ALLOW_LOCKED_KEY) return allowLocked;
      if (key === REQUIRE_ELEVATION_KEY) return requireElevation;
      return undefined;
    });
    const moduleRef = {
      get: () => workstation,
    };
    const localGuard = new AuthGuard(reflector, sessions, moduleRef as never);
    return {
      guard: localGuard,
      request,
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      } as never,
    };
  }

  it('reports NOT RUN when live PostgreSQL is unavailable', () => {
    if (ready) return;
    console.warn(
      'NOT RUN: security.workstation.live — AuthGuard lock, PIN unlock, concurrency, revoke, refresh-after-close',
    );
    expect(ready).toBe(false);
  });

  it('blocks protected APIs after lock; AllowLocked and refresh still work', async () => {
    if (!ready) {
      console.warn('NOT RUN: lock/refresh live scenario');
      return;
    }

    const opened = await openDirectorWorkSession();
    await workstation.lock(opened.actor, {});

    const blocked = mockHttp(opened.accessToken, false);
    await expect(blocked.guard.canActivate(blocked.context)).rejects.toMatchObject({
      code: 'WORKSTATION_LOCKED',
    });

    const allowed = mockHttp(opened.accessToken, true);
    await expect(allowed.guard.canActivate(allowed.context)).resolves.toBe(true);

    const rotated = await sessions.rotateSession(opened.refreshToken, {});
    expect(rotated?.accessToken).toBeTruthy();
    expect(rotated?.user.workstationLocked).toBe(true);

    const resolved = await sessions.resolveAuthenticatedUser(rotated!.accessToken);
    expect(resolved?.lockedAt).toBeTruthy();
  }, 120_000);

  it('unlocks with PIN, switches employee permissions, and revokes prior session', async () => {
    if (!ready) return;

    const opened = await openDirectorWorkSession();
    await workstation.lock(opened.actor, {});
    const priorSessionId = opened.actor.sessionId;

    const res = cookieResponse();
    const unlocked = await workstation.unlockWithPin(
      { userId: ids.florist, pin: pinFlorist },
      deviceRaw,
      {},
      res,
    );

    expect(unlocked.user.authStrength).toBe(AuthStrength.PIN);
    expect(unlocked.user.role).toBe(Role.FLORIST);
    expect(unlocked.user.permissions).toContain('orders.view');
    expect(unlocked.user.permissions).not.toContain('employees.manage');
    expect(unlocked.workSession.locked).toBe(false);

    const prior = await prisma.session.findUnique({ where: { id: priorSessionId } });
    expect(prior?.revokedAt).toBeTruthy();

    const resolved = await sessions.resolveAuthenticatedUser(unlocked.accessToken);
    expect(resolved?.id).toBe(ids.florist);
    expect(resolved?.lockedAt).toBeNull();
    expect(resolved?.authStrength).toBe(AuthStrength.PIN);

    const ok = mockHttp(unlocked.accessToken, false);
    await expect(ok.guard.canActivate(ok.context)).resolves.toBe(true);

    // Old access token must not work after revoke.
    const stale = mockHttp(opened.accessToken, false);
    await expect(stale.guard.canActivate(stale.context)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  }, 120_000);

  it('atomically counts concurrent failed PIN attempts and locks out', async () => {
    if (!ready) return;

    await openDirectorWorkSession();
    await prisma.securityPolicy.update({
      where: { id: 1 },
      data: { pinMaxAttempts: 5, pinLockoutMinutes: 15 },
    });
    await prisma.user.update({
      where: { id: ids.florist },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });

    const res = cookieResponse();
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        workstation.unlockWithPin({ userId: ids.florist, pin: '000000' }, deviceRaw, {}, res),
      ),
    );
    expect(attempts.every((a) => a.status === 'rejected')).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.florist } });
    expect(user.pinLockedUntil).toBeTruthy();
    expect(user.pinLockedUntil!.getTime()).toBeGreaterThan(Date.now());

    await expect(
      workstation.unlockWithPin({ userId: ids.florist, pin: pinFlorist }, deviceRaw, {}, res),
    ).rejects.toMatchObject({ code: 'PIN_TEMP_LOCKED' });

    await prisma.user.update({
      where: { id: ids.florist },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
  }, 180_000);

  it('serializes concurrent successful unlocks to a single active session', async () => {
    if (!ready) return;

    await openDirectorWorkSession();
    await prisma.user.update({
      where: { id: ids.florist },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
    await prisma.user.update({
      where: { id: ids.manager },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });

    const results = await Promise.allSettled([
      workstation.unlockWithPin(
        { userId: ids.florist, pin: pinFlorist },
        deviceRaw,
        {},
        cookieResponse(),
      ),
      workstation.unlockWithPin(
        { userId: ids.manager, pin: pinManager },
        deviceRaw,
        {},
        cookieResponse(),
      ),
      workstation.unlockWithPin(
        { userId: ids.florist, pin: pinFlorist },
        deviceRaw,
        {},
        cookieResponse(),
      ),
    ]);

    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins.length).toBeGreaterThanOrEqual(1);

    const active = await prisma.session.findMany({
      where: { workSessionId: ids.work, revokedAt: null },
    });
    expect(active).toHaveLength(1);
  }, 180_000);

  it('rejects employee switch when policy.allowEmployeeSwitch is false', async () => {
    if (!ready) return;

    const opened = await openDirectorWorkSession();
    await workstation.lock(opened.actor, {});
    await prisma.securityPolicy.update({
      where: { id: 1 },
      data: { allowEmployeeSwitch: false },
    });

    await expect(
      workstation.unlockWithPin(
        { userId: ids.florist, pin: pinFlorist },
        deviceRaw,
        {},
        cookieResponse(),
      ),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_SWITCH_DISABLED' });

    // Same user may unlock.
    await prisma.user.update({
      where: { id: ids.director },
      data: {
        pinEnabled: true,
        pinHash: await hashPin('111111'),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });
    const same = await workstation.unlockWithPin(
      { userId: ids.director, pin: '111111' },
      deviceRaw,
      {},
      cookieResponse(),
    );
    expect(same.user.id).toBe(ids.director);

    await prisma.securityPolicy.update({
      where: { id: 1 },
      data: { allowEmployeeSwitch: true },
    });
  }, 120_000);

  it('elevates PIN session without permanently upgrading authStrength', async () => {
    if (!ready) return;

    await openDirectorWorkSession();
    await prisma.user.update({
      where: { id: ids.florist },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
    const unlocked = await workstation.unlockWithPin(
      { userId: ids.florist, pin: pinFlorist },
      deviceRaw,
      {},
      cookieResponse(),
    );
    const actor = (await sessions.resolveAuthenticatedUser(unlocked.accessToken))!;
    expect(actor.authStrength).toBe(AuthStrength.PIN);

    const elevated = await sessions.elevateWithPassword(actor, 'LiveTest123!');
    expect(new Date(elevated.elevatedUntil).getTime()).toBeGreaterThan(Date.now());

    const after = await prisma.session.findUniqueOrThrow({ where: { id: actor.sessionId } });
    expect(after.authStrength).toBe(AuthStrength.PIN);
    expect(after.elevatedUntil).toBeTruthy();

    const stepUp = mockHttp(unlocked.accessToken, false, true);
    await expect(stepUp.guard.canActivate(stepUp.context)).resolves.toBe(true);
    expect(stepUp.request.user?.authStrength).toBe(AuthStrength.PIN);
    expect(stepUp.request.user?.elevatedUntil).toBeTruthy();
  }, 120_000);

  it('revokes device, closes work session, and rejects further PIN unlock', async () => {
    if (!ready) return;

    const opened = await openDirectorWorkSession();
    const director = await prisma.user.findUniqueOrThrow({ where: { id: ids.director } });
    const elevatedActor: AuthenticatedUser = {
      id: director.id,
      name: director.name,
      login: director.login,
      role: Role.DIRECTOR,
      sessionId: opened.actor.sessionId,
      isActive: true,
      authStrength: AuthStrength.PASSWORD,
      elevatedUntil: new Date(Date.now() + 15 * 60 * 1000),
      workSessionId: opened.actor.workSessionId,
      lockedAt: null,
    };

    await devices.revoke(elevatedActor, ids.device, {}, cookieResponse(), deviceRaw);

    const work = await prisma.workSession.findUniqueOrThrow({ where: { id: ids.work } });
    expect(work.closedAt).toBeTruthy();

    await expect(
      workstation.unlockWithPin(
        { userId: ids.florist, pin: pinFlorist },
        deviceRaw,
        {},
        cookieResponse(),
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' });

    // Recreate device for remaining cleanup / isolation of later runs in same file order —
    // this is the last test that needs the device.
  }, 120_000);

  it('rejects refresh after work session logout close', async () => {
    if (!ready) return;

    // New device because previous test revoked the old one.
    deviceRaw = generateOpaqueToken(32);
    const device = await prisma.trustedDevice.create({
      data: {
        name: `WS Device2 ${suffix}`,
        tokenHash: hashToken(deviceRaw),
        accessMode: DeviceAccessMode.ALL_PIN_USERS,
        createdByUserId: ids.director,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    ids.device = device.id;

    const opened = await openDirectorWorkSession();
    // Simulate logout path: close work + revoke sessions.
    await prisma.workSession.update({
      where: { id: ids.work },
      data: { closedAt: new Date(), closeReason: 'LOGOUT' },
    });

    const rotated = await sessions.rotateSession(opened.refreshToken, {});
    expect(rotated).toBeNull();
  }, 120_000);
});
