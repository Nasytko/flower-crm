import { Role } from '@erp/shared';
import { EmployeesService } from './employees.service';

describe('EmployeesService', () => {
  const prismaMock = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    session: {
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };

  const audit = { log: jest.fn() };
  const service = new EmployeesService(prismaMock as never, audit as never);
  const actor = {
    id: 'director-1',
    name: 'Director',
    login: 'director',
    role: Role.DIRECTOR,
    sessionId: 's1',
    isActive: true,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );
  });

  it('creates an employee without returning passwordHash', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'e1',
      name: 'Anna',
      login: 'anna',
      role: Role.FLORIST,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      passwordHash: 'secret-hash',
    });

    const created = await service.create(
      actor,
      { name: 'Anna', login: 'anna', role: Role.FLORIST, password: 'Florist123!' },
      {},
    );

    expect(created).not.toHaveProperty('passwordHash');
    expect(created.login).toBe('anna');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EMPLOYEE_CREATED' }));
  });

  it('rejects duplicate login', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'existing' });
    await expect(
      service.create(
        actor,
        { name: 'Anna', login: 'anna', role: Role.FLORIST, password: 'Florist123!' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'LOGIN_TAKEN' });
  });

  it('protects the last active director from deactivation', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'director-1',
      name: 'Director',
      login: 'director',
      role: Role.DIRECTOR,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      passwordHash: 'x',
    });
    prismaMock.user.count.mockResolvedValue(1);

    await expect(
      service.update(actor, 'director-1', { isActive: false }, {}),
    ).rejects.toMatchObject({
      code: 'LAST_DIRECTOR_PROTECTED',
    });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
  });

  it('revokes sessions on password reset', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'e1',
      login: 'anna',
    });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.session.updateMany.mockResolvedValue({ count: 1 });

    await service.resetPassword(actor, 'e1', { newPassword: 'NewPass123!' }, {});

    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'e1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('maps Prisma unique violation on create to LOGIN_TAKEN', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.create(
        actor,
        { name: 'Anna', login: 'anna', role: Role.FLORIST, password: 'Florist123!' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'LOGIN_TAKEN' });
  });
});
