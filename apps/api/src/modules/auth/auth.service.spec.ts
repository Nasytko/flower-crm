import { HttpStatus } from '@nestjs/common';
import { Role } from '@erp/shared';
import { AuthService } from './auth.service';
import { AppError } from '../../common/errors/app-error';

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const sessions = {
    createSession: jest.fn(),
    rotateSession: jest.fn(),
    revokeByRefreshToken: jest.fn(),
    revokeAllUserSessions: jest.fn(),
    toAuthUser: jest.fn(),
  };

  const audit = {
    log: jest.fn(),
  };

  const service = new AuthService(prisma as never, sessions as never, audit as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('logs in with valid credentials', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      name: 'Director',
      login: 'director',
      email: 'director@example.com',
      role: Role.DIRECTOR,
      isActive: true,
      passwordHash: await (
        await import('../../common/security/password')
      ).hashPassword('Director123!'),
    });
    sessions.createSession.mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
      user: {
        id: 'u1',
        name: 'Director',
        login: 'director',
        email: 'director@example.com',
        role: Role.DIRECTOR,
        permissions: [],
      },
    });
    prisma.user.update.mockResolvedValue({});

    const result = await service.login(
      { login: 'director', password: 'Director123!' },
      { ipAddress: '127.0.0.1', userAgent: 'Mozilla/5.0 Chrome/120' },
    );

    expect(result.accessToken).toBe('access');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastLoginUserAgent: 'Mozilla/5.0 Chrome/120',
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGIN_SUCCESS' }));
  });

  it('returns the same INVALID_CREDENTIALS for unknown login', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.login({ login: 'missing', password: 'whatever12' }, {}),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN_FAILED',
        metadata: expect.objectContaining({ reason: 'unknown_login' }),
      }),
    );
  });

  it('runs dummy password verification for inactive users', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      login: 'director',
      email: null,
      isActive: false,
      passwordHash: await (
        await import('../../common/security/password')
      ).hashPassword('Director123!'),
    });

    await expect(
      service.login({ login: 'director', password: 'Director123!' }, {}),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'inactive' }),
      }),
    );
  });

  it('returns the same INVALID_CREDENTIALS for bad password', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      login: 'director',
      email: null,
      isActive: true,
      passwordHash: await (
        await import('../../common/security/password')
      ).hashPassword('Director123!'),
    });

    await expect(
      service.login({ login: 'director', password: 'WrongPass1!' }, {}),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects invalid refresh tokens', async () => {
    sessions.rotateSession.mockResolvedValue(null);
    await expect(service.refresh('bad', {})).rejects.toMatchObject({ code: 'INVALID_SESSION' });
  });
});
