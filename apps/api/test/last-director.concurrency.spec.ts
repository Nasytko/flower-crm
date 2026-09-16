import { Role } from '@erp/shared';
import { createPrismaClient } from '@erp/database';
import { EmployeesService } from '../src/modules/employees/employees.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { hashPassword } from '../src/common/security/password';

/**
 * Live Postgres concurrency check for last-director protection.
 * Temporarily isolates active directors to the two users created here, then restores.
 */
describe('EmployeesService last-director concurrency (live DB)', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    it.skip('DATABASE_URL is not set', () => undefined);
    return;
  }

  const prisma = createPrismaClient(databaseUrl);
  const audit = new AuditService(prisma as never);
  const service = new EmployeesService(prisma as never, audit);
  const suffix = Date.now().toString(36);

  let directorAId = '';
  let directorBId = '';
  let pausedDirectorIds: string[] = [];
  let ready = false;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return;
    }

    const passwordHash = await hashPassword('LiveTest123!');

    const existingDirectors = await prisma.user.findMany({
      where: { role: Role.DIRECTOR, isActive: true },
      select: { id: true },
    });
    pausedDirectorIds = existingDirectors.map((d) => d.id);
    if (pausedDirectorIds.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: pausedDirectorIds } },
        data: { isActive: false },
      });
    }

    const a = await prisma.user.create({
      data: {
        login: `dir_a_${suffix}`,
        name: 'Director A',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    const b = await prisma.user.create({
      data: {
        login: `dir_b_${suffix}`,
        name: 'Director B',
        role: Role.DIRECTOR,
        passwordHash,
      },
    });
    directorAId = a.id;
    directorBId = b.id;
    ready = true;
  }, 60_000);

  afterAll(async () => {
    try {
      const ids = [directorAId, directorBId].filter(Boolean);
      if (ids.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: ids } } });
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ entityId: { in: ids } }, { actorUserId: { in: ids } }],
          },
        });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
      if (pausedDirectorIds.length > 0) {
        await prisma.user.updateMany({
          where: { id: { in: pausedDirectorIds } },
          data: { isActive: true },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('allows only one of two concurrent demotions when exactly two directors exist', async () => {
    if (!ready) {
      return;
    }

    const actor = {
      id: directorAId,
      name: 'Director A',
      login: `dir_a_${suffix}`,
      role: Role.DIRECTOR,
      sessionId: 'live-test',
      isActive: true,
    };

    const results = await Promise.allSettled([
      service.update(actor, directorAId, { role: Role.MANAGER }, {}),
      service.update(actor, directorBId, { role: Role.MANAGER }, {}),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'LAST_DIRECTOR_PROTECTED',
    });

    const activeDirectors = await prisma.user.count({
      where: {
        id: { in: [directorAId, directorBId] },
        role: Role.DIRECTOR,
        isActive: true,
      },
    });
    expect(activeDirectors).toBe(1);
  }, 60_000);
});
