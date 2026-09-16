import jwt from 'jsonwebtoken';
import { Role } from '@erp/shared';
import { SessionService } from './session.service';
import { hashToken } from '../../common/security/tokens';

describe('SessionService.refresh rotation', () => {
  const prismaMock = {
    user: {
      findUnique: jest.fn(),
    },
    session: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const config = {
    jwtAccessSecret: 'local-dev-access-secret-change-me-32chars',
    jwtAccessTtlSeconds: 900,
    sessionTtlSeconds: 1209600,
    authCookieName: 'erp_refresh',
    isProduction: false,
  };

  const service = new SessionService(prismaMock as never, config as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('rotates atomically and stores previousTokenHash', async () => {
    const refreshToken = 'a'.repeat(64);
    const tokenHash = hashToken(refreshToken);
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      tokenHash,
      previousTokenHash: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      user: {
        id: 'u1',
        name: 'Director',
        login: 'director',
        role: Role.DIRECTOR,
        isActive: true,
      },
    });
    prismaMock.session.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.rotateSession(refreshToken, {});
    expect(result?.accessToken).toBeTruthy();
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 's1', tokenHash }),
        data: expect.objectContaining({ previousTokenHash: tokenHash }),
      }),
    );
  });

  it('returns null when concurrent rotation already won', async () => {
    const refreshToken = 'b'.repeat(64);
    const tokenHash = hashToken(refreshToken);
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      tokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      user: {
        id: 'u1',
        name: 'Director',
        login: 'director',
        role: Role.DIRECTOR,
        isActive: true,
      },
    });
    prismaMock.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.rotateSession(refreshToken, {})).resolves.toBeNull();
  });

  it('revokes all sessions when a previous refresh token is reused after grace', async () => {
    const refreshToken = 'c'.repeat(64);
    prismaMock.session.findUnique.mockResolvedValue(null);
    prismaMock.session.findFirst.mockResolvedValue({
      userId: 'u1',
      lastUsedAt: new Date(Date.now() - 60_000),
    });
    prismaMock.session.updateMany.mockResolvedValue({ count: 2 });

    await expect(service.rotateSession(refreshToken, {})).resolves.toBeNull();
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('does not revoke on previous-token match inside grace window', async () => {
    const refreshToken = 'd'.repeat(64);
    prismaMock.session.findUnique.mockResolvedValue(null);
    prismaMock.session.findFirst.mockResolvedValue({
      userId: 'u1',
      lastUsedAt: new Date(),
    });

    await expect(service.rotateSession(refreshToken, {})).resolves.toBeNull();
    expect(prismaMock.session.updateMany).not.toHaveBeenCalled();
  });

  it('verifies access tokens with HS256 only', async () => {
    const token = jwt.sign(
      { sub: 'u1', sid: 's1', role: Role.DIRECTOR, login: 'director' },
      config.jwtAccessSecret,
      { algorithm: 'HS256', expiresIn: 60 },
    );
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      name: 'Director',
      login: 'director',
      role: Role.DIRECTOR,
      isActive: true,
    });
    prismaMock.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const auth = await service.resolveAuthenticatedUser(token);
    expect(auth?.id).toBe('u1');
  });
});
