import { createPrismaClient } from '@erp/database';
import { Role } from '@erp/shared';
import { SessionService } from '../src/modules/auth/session.service';
import { hashPassword } from '../src/common/security/password';

describe('SessionService refresh concurrency (live DB)', () => {
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
  const sessions = new SessionService(prisma as never, config as never);
  const suffix = Date.now().toString(36);
  let userId = '';
  let ready = false;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return;
    }

    const passwordHash = await hashPassword('LiveTest123!');
    const user = await prisma.user.create({
      data: {
        login: `refresh_${suffix}`,
        name: 'Refresh User',
        role: Role.MANAGER,
        passwordHash,
      },
    });
    userId = user.id;
    ready = true;
  }, 60_000);

  afterAll(async () => {
    try {
      if (userId) {
        await prisma.session.deleteMany({ where: { userId } });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ entityId: userId }, { actorUserId: userId }] },
        });
        await prisma.user.delete({ where: { id: userId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('allows only one concurrent rotateSession to succeed', async () => {
    if (!ready) {
      return;
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const created = await sessions.createSession(
      { id: user.id, name: user.name, login: user.login, role: Role.MANAGER },
      {},
    );

    const results = await Promise.all([
      sessions.rotateSession(created.refreshToken, {}),
      sessions.rotateSession(created.refreshToken, {}),
      sessions.rotateSession(created.refreshToken, {}),
      sessions.rotateSession(created.refreshToken, {}),
      sessions.rotateSession(created.refreshToken, {}),
    ]);

    const wins = results.filter((r) => r !== null);
    const losses = results.filter((r) => r === null);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(4);

    const active = await prisma.session.count({
      where: { userId, revokedAt: null },
    });
    expect(active).toBe(1);
  }, 60_000);

  it('detects reuse of a rotated refresh token after grace and revokes sessions', async () => {
    if (!ready) {
      return;
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const created = await sessions.createSession(
      { id: user.id, name: user.name, login: user.login, role: Role.MANAGER },
      {},
    );
    const first = await sessions.rotateSession(created.refreshToken, {});
    expect(first).not.toBeNull();

    // Age the rotation beyond the reuse grace window.
    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { lastUsedAt: new Date(Date.now() - 60_000) },
    });

    const reuse = await sessions.rotateSession(created.refreshToken, {});
    expect(reuse).toBeNull();

    const active = await prisma.session.count({
      where: { userId, revokedAt: null },
    });
    expect(active).toBe(0);
  }, 60_000);
});
