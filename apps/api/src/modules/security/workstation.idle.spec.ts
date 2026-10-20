import { AuthStrength, Role, WorkSessionCloseReason } from '@erp/shared';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { WorkstationService } from './workstation.service';

describe('WorkstationService server idle timeout', () => {
  const prisma: {
    workSession: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    session: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  } = {
    workSession: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    session: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
    fn(prisma),
  );
  const audit = { log: jest.fn() };
  const sessions = {};
  const policy = {
    get: jest.fn().mockResolvedValue({ idleLockMinutes: 5 }),
  };
  const devices = {};

  const service = new WorkstationService(
    prisma as never,
    audit as never,
    sessions as never,
    policy as never,
    devices as never,
  );

  const actor: AuthenticatedUser = {
    id: 'u1',
    name: 'User',
    login: 'user',
    role: Role.FLORIST,
    sessionId: 's1',
    isActive: true,
    authStrength: AuthStrength.PASSWORD,
    elevatedUntil: null,
    workSessionId: 'w1',
    lockedAt: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    policy.get.mockResolvedValue({ idleLockMinutes: 5 });
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
  });

  it('returns shouldLock when session already locked', async () => {
    const result = await service.recordUserActivity({
      ...actor,
      lockedAt: new Date(),
    });
    expect(result).toEqual({ shouldLock: true });
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('enforceIdleLockIfNeeded locks when idle exceeded without refreshing activity', async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    prisma.workSession.findUnique.mockResolvedValue({
      id: 'w1',
      closedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      lastUserActivityAt: stale,
      lockedAt: null,
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.workSession.update.mockResolvedValue({});

    await expect(service.enforceIdleLockIfNeeded(actor)).resolves.toBe(true);
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workSessionId: 'w1', revokedAt: null },
        data: expect.objectContaining({ lockedAt: expect.any(Date) }),
      }),
    );
  });

  it('enforceIdleLockIfNeeded returns false within idle window (no lock, no activity bump)', async () => {
    const recent = new Date(Date.now() - 30_000);
    prisma.workSession.findUnique.mockResolvedValue({
      id: 'w1',
      closedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      lastUserActivityAt: recent,
      lockedAt: null,
    });

    await expect(service.enforceIdleLockIfNeeded(actor)).resolves.toBe(false);
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('locks when lastUserActivityAt exceeds idleLockMinutes via recordUserActivity', async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    prisma.workSession.findUnique.mockResolvedValue({
      id: 'w1',
      closedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      lastUserActivityAt: stale,
      lockedAt: null,
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.workSession.update.mockResolvedValue({});

    const result = await service.recordUserActivity(actor);
    expect(result).toEqual({ shouldLock: true });
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workSessionId: 'w1', revokedAt: null },
        data: expect.objectContaining({ lockedAt: expect.any(Date) }),
      }),
    );
  });

  it('refreshes activity timestamps when within idle window', async () => {
    const recent = new Date(Date.now() - 30_000);
    prisma.workSession.findUnique.mockResolvedValue({
      id: 'w1',
      closedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      lastUserActivityAt: recent,
      lockedAt: null,
    });

    const result = await service.recordUserActivity(actor);
    expect(result).toEqual({ shouldLock: false });
    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ lastUserActivityAt: expect.any(Date) }),
      }),
    );
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('closes expired work session instead of only locking', async () => {
    prisma.workSession.findUnique.mockResolvedValue({
      id: 'w1',
      closedAt: null,
      expiresAt: new Date(Date.now() - 1_000),
    });
    prisma.workSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.recordUserActivity(actor);
    expect(result).toEqual({ shouldLock: true });
    expect(prisma.workSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w1', closedAt: null },
        data: expect.objectContaining({ closeReason: WorkSessionCloseReason.EXPIRED }),
      }),
    );
  });
});
