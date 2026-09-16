import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction, Role } from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import {
  hashPassword,
  runDummyPasswordVerification,
  verifyPassword,
} from '../../common/security/password';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionService } from './session.service';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, context: RequestContext) {
    const identifier = dto.login.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { login: identifier },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });

    if (!user || !user.isActive) {
      await runDummyPasswordVerification(dto.password);
      await this.audit.log({
        action: AuditAction.LOGIN_FAILED,
        actorUserId: null,
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: { login: identifier, reason: !user ? 'unknown_login' : 'inactive' },
        context,
      });
      throw new AppError(
        'INVALID_CREDENTIALS',
        'Неверный логин или пароль',
        {},
        HttpStatus.UNAUTHORIZED,
      );
    }

    const passwordValid = await verifyPassword(user.passwordHash, dto.password);
    if (!passwordValid) {
      await this.audit.log({
        action: AuditAction.LOGIN_FAILED,
        actorUserId: null,
        entityType: 'User',
        entityId: user.id,
        metadata: { login: identifier, reason: 'bad_password' },
        context,
      });
      throw new AppError(
        'INVALID_CREDENTIALS',
        'Неверный логин или пароль',
        {},
        HttpStatus.UNAUTHORIZED,
      );
    }

    const auth = await this.sessions.createSession(
      {
        id: user.id,
        name: user.name,
        login: user.login,
        email: user.email,
        role: user.role as Role,
      },
      context,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginUserAgent: context.userAgent?.slice(0, 512) ?? null,
      },
    });

    await this.audit.log({
      action: AuditAction.LOGIN_SUCCESS,
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      metadata: { login: user.login },
      context,
    });

    return auth;
  }

  async refresh(refreshToken: string | undefined, context: RequestContext) {
    if (!refreshToken) {
      throw new AppError('INVALID_SESSION', 'Сессия недействительна', {}, HttpStatus.UNAUTHORIZED);
    }

    const rotated = await this.sessions.rotateSession(refreshToken, context);
    if (!rotated) {
      throw new AppError('INVALID_SESSION', 'Сессия недействительна', {}, HttpStatus.UNAUTHORIZED);
    }

    return rotated;
  }

  async logout(refreshToken: string | undefined, context: RequestContext): Promise<void> {
    if (!refreshToken) {
      return;
    }

    const userId = await this.sessions.revokeByRefreshToken(refreshToken);
    if (userId) {
      await this.audit.log({
        action: AuditAction.LOGOUT,
        actorUserId: userId,
        entityType: 'Session',
        metadata: {},
        context,
      });
    }
  }

  async logoutAll(actor: AuthenticatedUser, context: RequestContext): Promise<void> {
    const count = await this.sessions.revokeAllUserSessions(actor.id);
    await this.audit.log({
      action: AuditAction.LOGOUT_ALL,
      actorUserId: actor.id,
      entityType: 'User',
      entityId: actor.id,
      metadata: { revokedSessions: count },
      context,
    });
  }

  async me(actor: AuthenticatedUser) {
    return this.sessions.toAuthUser(actor);
  }

  async changePassword(
    actor: AuthenticatedUser,
    dto: ChangePasswordDto,
    context: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    const valid = await verifyPassword(user.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new AppError(
        'INVALID_CREDENTIALS',
        'Неверный текущий пароль',
        {},
        HttpStatus.UNAUTHORIZED,
      );
    }

    const passwordHash = await hashPassword(dto.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: actor.id },
        data: { passwordHash },
      });
      await tx.session.updateMany({
        where: { userId: actor.id, revokedAt: null, id: { not: actor.sessionId } },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        action: AuditAction.PASSWORD_CHANGED,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: actor.id,
        context,
        tx,
      });
    });
  }
}
