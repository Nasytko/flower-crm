import { Injectable } from '@nestjs/common';
import { CookieOptions, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthUser, getPermissionsForRole, Role } from '@erp/shared';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashToken } from '../../common/security/tokens';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: Role;
  login: string;
}

const JWT_ALGORITHM = 'HS256' as const;

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async createSession(
    user: { id: string; name: string; login: string; email?: string | null; role: Role },
    context: RequestContext,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; user: AuthUser }> {
    const refreshToken = generateOpaqueToken();
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        expiresAt,
        lastUsedAt: new Date(),
      },
    });

    const accessToken = this.signAccessToken({
      sub: user.id,
      sid: session.id,
      role: user.role,
      login: user.login,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.jwtAccessTtlSeconds,
      user: this.toAuthUser(user),
    };
  }

  /**
   * Rotate refresh token atomically.
   * - Concurrent refresh: only one updateMany wins; losers get null.
   * - Reuse of previousTokenHash outside a short grace window → revoke all sessions.
   * - previousTokenHash hits inside the grace window → lost concurrent race (no mass revoke).
   */
  async rotateSession(
    refreshToken: string,
    context: RequestContext,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: AuthUser;
  } | null> {
    const tokenHash = hashToken(refreshToken);
    const now = new Date();

    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (session) {
      if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
        return null;
      }

      if (!session.user.isActive) {
        await this.revokeSessionById(session.id);
        return null;
      }

      const nextRefreshToken = generateOpaqueToken();
      const nextHash = hashToken(nextRefreshToken);
      const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);

      const rotated = await this.prisma.session.updateMany({
        where: {
          id: session.id,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          previousTokenHash: tokenHash,
          tokenHash: nextHash,
          expiresAt,
          lastUsedAt: now,
          ipAddress: context.ipAddress ?? session.ipAddress,
          userAgent: context.userAgent ?? session.userAgent,
        },
      });

      if (rotated.count !== 1) {
        return null;
      }

      const accessToken = this.signAccessToken({
        sub: session.user.id,
        sid: session.id,
        role: session.user.role as Role,
        login: session.user.login,
      });

      return {
        accessToken,
        refreshToken: nextRefreshToken,
        expiresIn: this.config.jwtAccessTtlSeconds,
        user: this.toAuthUser({
          id: session.user.id,
          name: session.user.name,
          login: session.user.login,
          email: session.user.email,
          role: session.user.role as Role,
        }),
      };
    }

    const previous = await this.prisma.session.findFirst({
      where: { previousTokenHash: tokenHash },
      select: { userId: true, lastUsedAt: true },
    });
    if (previous) {
      const rotatedAt = previous.lastUsedAt?.getTime() ?? 0;
      const withinGrace = Date.now() - rotatedAt <= SessionService.REFRESH_REUSE_GRACE_MS;
      if (!withinGrace) {
        await this.revokeAllUserSessions(previous.userId);
      }
      return null;
    }

    return null;
  }

  private static readonly REFRESH_REUSE_GRACE_MS = 10_000;

  async revokeByRefreshToken(refreshToken: string): Promise<string | null> {
    const tokenHash = hashToken(refreshToken);
    const session = await this.prisma.session.findFirst({
      where: {
        OR: [{ tokenHash }, { previousTokenHash: tokenHash }],
        revokedAt: null,
      },
    });
    if (!session) {
      return null;
    }

    await this.revokeSessionById(session.id);
    return session.userId;
  }

  async revokeSessionById(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Deletes expired sessions and revoked sessions older than retentionDays. */
  async cleanupStaleSessions(retentionDays = 30): Promise<number> {
    const revokedBefore = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.session.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: revokedBefore } }],
      },
    });
    return result.count;
  }

  async resolveAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser | null> {
    try {
      const payload = jwt.verify(accessToken, this.config.jwtAccessSecret, {
        algorithms: [JWT_ALGORITHM],
      }) as AccessTokenPayload;

      const [user, session] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: payload.sub } }),
        this.prisma.session.findUnique({ where: { id: payload.sid } }),
      ]);

      if (!user || !user.isActive) {
        return null;
      }

      if (!session || session.userId !== user.id || session.revokedAt) {
        return null;
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        return null;
      }

      return {
        id: user.id,
        name: user.name,
        login: user.login,
        email: user.email,
        role: user.role as Role,
        sessionId: session.id,
        isActive: user.isActive,
      };
    } catch {
      return null;
    }
  }

  setRefreshCookie(response: Response, refreshToken: string): void {
    response.cookie(this.config.authCookieName, refreshToken, this.cookieOptions());
  }

  clearRefreshCookie(response: Response): void {
    response.clearCookie(this.config.authCookieName, this.cookieOptions());
  }

  toAuthUser(user: {
    id: string;
    name: string;
    login: string;
    email?: string | null;
    role: Role;
  }): AuthUser {
    return {
      id: user.id,
      name: user.name,
      login: user.login,
      email: user.email ?? null,
      role: user.role,
      permissions: [...getPermissionsForRole(user.role)],
    };
  }

  private signAccessToken(payload: AccessTokenPayload): string {
    return jwt.sign(payload, this.config.jwtAccessSecret, {
      algorithm: JWT_ALGORITHM,
      expiresIn: this.config.jwtAccessTtlSeconds,
    });
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: this.config.sessionTtlSeconds * 1000,
    };
  }
}
