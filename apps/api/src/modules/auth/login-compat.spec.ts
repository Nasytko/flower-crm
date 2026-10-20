import { AuthStrength, Role } from '@erp/shared';
import { SessionService } from './session.service';

/**
 * Backward compatibility: password login must keep working without trusted device / PIN /
 * work session. Legacy sessions default to authStrength=PASSWORD and unlocked.
 */
describe('Password login backward compatibility', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  const config = {
    jwtAccessSecret: 'local-dev-access-secret-change-me-32chars',
    jwtAccessTtlSeconds: 900,
    sessionTtlSeconds: 1209600,
    authCookieName: 'erp_refresh',
    isProduction: false,
  };
  const service = new SessionService(prisma as never, config as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.session.create.mockResolvedValue({
      id: 's-legacy',
      authStrength: AuthStrength.PASSWORD,
      elevatedUntil: new Date(Date.now() + 15 * 60 * 1000),
      workSessionId: null,
      lockedAt: null,
    });
  });

  it('createSession defaults to PASSWORD strength without work session', async () => {
    const result = await service.createSession(
      {
        id: 'u1',
        name: 'Director',
        login: 'director',
        role: Role.DIRECTOR,
      },
      {},
    );

    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authStrength: AuthStrength.PASSWORD,
          workSessionId: null,
          lockedAt: null,
          elevatedUntil: expect.any(Date),
        }),
      }),
    );
    expect(result.user.authStrength).toBe(AuthStrength.PASSWORD);
    expect(result.user.workSessionActive).toBe(false);
    expect(result.user.workstationLocked).toBe(false);
    expect(result.accessToken).toBeTruthy();
  });

  it('resolveAuthenticatedUser accepts legacy session without workSessionId', async () => {
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign(
      { sub: 'u1', sid: 's-legacy', role: Role.DIRECTOR, login: 'director' },
      config.jwtAccessSecret,
      { algorithm: 'HS256', expiresIn: 60 },
    );

    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      name: 'Director',
      login: 'director',
      email: null,
      role: Role.DIRECTOR,
      isActive: true,
    });
    prisma.session.findUnique.mockResolvedValue({
      id: 's-legacy',
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      authStrength: AuthStrength.PASSWORD,
      elevatedUntil: new Date(Date.now() + 60_000),
      workSessionId: null,
      lockedAt: null,
      workSession: null,
    });

    const auth = await service.resolveAuthenticatedUser(token);
    expect(auth).toMatchObject({
      id: 'u1',
      authStrength: AuthStrength.PASSWORD,
      workSessionId: null,
      lockedAt: null,
    });
  });
});
