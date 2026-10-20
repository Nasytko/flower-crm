import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction } from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { isElevated } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { computePinStatus, generatePinPlaintext, hashPin } from './pin.util';

@Injectable()
export class EmployeePinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async enable(actor: AuthenticatedUser, userId: string, context: RequestContext) {
    this.assertElevated(actor);
    const user = await this.requireUser(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinEnabled: true },
    });
    await this.audit.log({
      action: AuditAction.PIN_ENABLED,
      actorUserId: actor.id,
      entityType: 'User',
      entityId: userId,
      context,
    });
    return this.statusDto(userId);
  }

  async disable(actor: AuthenticatedUser, userId: string, context: RequestContext) {
    this.assertElevated(actor);
    await this.requireUser(userId);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          pinEnabled: false,
          pinHash: null,
          pinUpdatedAt: new Date(),
          pinFailedAttempts: 0,
          pinLockedUntil: null,
        },
      });
      // Revoke sessions that were established via PIN for this user.
      await tx.session.updateMany({
        where: { userId, revokedAt: null, authStrength: 'PIN' },
        data: { revokedAt: new Date(), lockedAt: new Date() },
      });
      await this.audit.log({
        action: AuditAction.PIN_DISABLED,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: userId,
        context,
        tx,
      });
    });
    return this.statusDto(userId);
  }

  async generate(actor: AuthenticatedUser, userId: string, context: RequestContext) {
    this.assertElevated(actor);
    await this.requireUser(userId);
    const plaintext = generatePinPlaintext();
    const pinHash = await hashPin(plaintext);
    const hadPin = Boolean(
      (await this.prisma.user.findUnique({ where: { id: userId }, select: { pinHash: true } }))
        ?.pinHash,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          pinEnabled: true,
          pinHash,
          pinUpdatedAt: new Date(),
          pinFailedAttempts: 0,
          pinLockedUntil: null,
        },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null, authStrength: 'PIN' },
        data: { revokedAt: new Date(), lockedAt: new Date() },
      });
      await this.audit.log({
        action: hadPin ? AuditAction.PIN_RESET : AuditAction.PIN_GENERATED,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: userId,
        metadata: { rotated: hadPin },
        context,
        tx,
      });
    });

    return { ...(await this.statusDto(userId)), pinPlaintext: plaintext };
  }

  async revokeQuickSessions(
    actor: AuthenticatedUser,
    userId: string,
    context: RequestContext,
  ): Promise<{ revoked: number }> {
    this.assertElevated(actor);
    await this.requireUser(userId);
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), lockedAt: new Date() },
    });
    await this.audit.log({
      action: AuditAction.PIN_SESSIONS_REVOKED,
      actorUserId: actor.id,
      entityType: 'User',
      entityId: userId,
      metadata: { revoked: result.count },
      context,
    });
    return { revoked: result.count };
  }

  async statusDto(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        pinEnabled: true,
        pinHash: true,
        pinUpdatedAt: true,
        pinLockedUntil: true,
      },
    });
    return {
      pinEnabled: user.pinEnabled,
      pinStatus: computePinStatus(user),
      pinUpdatedAt: user.pinUpdatedAt?.toISOString() ?? null,
      pinLockedUntil: user.pinLockedUntil?.toISOString() ?? null,
    };
  }

  private async requireUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('NOT_FOUND', 'Сотрудник не найден', {}, HttpStatus.NOT_FOUND);
    }
    return user;
  }

  private assertElevated(actor: AuthenticatedUser): void {
    if (!isElevated(actor)) {
      throw new AppError(
        'STEP_UP_REQUIRED',
        'Для управления PIN подтвердите пароль',
        {},
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
