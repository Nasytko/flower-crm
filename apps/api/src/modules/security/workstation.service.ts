import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  AuthStrength,
  DeviceAccessMode,
  Role,
  WorkSessionCloseReason,
  type PinCandidateDto,
  type WorkSessionStatusDto,
} from '@erp/shared';
import type { Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { SecurityPolicyService } from './security-policy.service';
import { TrustedDeviceService } from './trusted-device.service';
import { assertPinFormat, computePinStatus, verifyPin } from './pin.util';

const ELEVATION_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class WorkstationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly policy: SecurityPolicyService,
    private readonly devices: TrustedDeviceService,
  ) {}

  async status(
    actor: AuthenticatedUser | null,
    deviceToken: string | undefined,
  ): Promise<WorkSessionStatusDto> {
    const policy = await this.policy.get();
    const device = await this.devices.resolveDevice(deviceToken);
    if (!actor?.workSessionId) {
      return {
        active: false,
        workSessionId: null,
        deviceId: device?.id ?? null,
        deviceName: device?.name ?? null,
        expiresAt: null,
        locked: false,
        idleLockMinutes: policy.idleLockMinutes,
        allowEmployeeSwitch: policy.allowEmployeeSwitch,
        authStrength: actor?.authStrength ?? null,
        elevated: actor
          ? actor.elevatedUntil != null && actor.elevatedUntil.getTime() > Date.now()
          : false,
      };
    }

    const work = await this.prisma.workSession.findUnique({
      where: { id: actor.workSessionId },
      include: { device: true },
    });
    const closed = !work || work.closedAt != null || work.expiresAt.getTime() <= Date.now();
    return {
      active: !closed,
      workSessionId: closed ? null : work!.id,
      deviceId: work?.deviceId ?? device?.id ?? null,
      deviceName: work?.device.name ?? device?.name ?? null,
      expiresAt: work && !closed ? work.expiresAt.toISOString() : null,
      locked: Boolean(actor.lockedAt) || Boolean(work?.lockedAt),
      idleLockMinutes: policy.idleLockMinutes,
      allowEmployeeSwitch: policy.allowEmployeeSwitch,
      authStrength: actor.authStrength ?? null,
      elevated: actor.elevatedUntil != null && actor.elevatedUntil.getTime() > Date.now(),
    };
  }

  async openWorkSession(
    actor: AuthenticatedUser,
    deviceToken: string | undefined,
    context: RequestContext,
  ): Promise<WorkSessionStatusDto> {
    const policy = await this.policy.get();
    if (!policy.pinEnabledOrg) {
      throw new AppError(
        'PIN_DISABLED',
        'PIN-вход отключён в организации',
        {},
        HttpStatus.CONFLICT,
      );
    }
    if (actor.authStrength !== AuthStrength.PASSWORD) {
      throw new AppError(
        'PASSWORD_REQUIRED',
        'Рабочую сессию можно открыть только после входа по паролю',
        {},
        HttpStatus.FORBIDDEN,
      );
    }
    const device = await this.devices.resolveDevice(deviceToken);
    if (!device) {
      throw new AppError(
        'DEVICE_NOT_TRUSTED',
        'Это устройство не является доверенным',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    // Close any other open work sessions on this device and revoke their sessions.
    const previousOpen = await this.prisma.workSession.findMany({
      where: { deviceId: device.id, closedAt: null },
      select: { id: true },
    });
    const previousIds = previousOpen.map((w) => w.id);
    if (previousIds.length) {
      await this.prisma.$transaction(async (tx) => {
        await tx.workSession.updateMany({
          where: { id: { in: previousIds }, closedAt: null },
          data: { closedAt: new Date(), closeReason: WorkSessionCloseReason.MANUAL },
        });
        await tx.session.updateMany({
          where: { workSessionId: { in: previousIds }, revokedAt: null },
          data: { revokedAt: new Date(), lockedAt: new Date() },
        });
      });
    }

    const expiresAt = new Date(Date.now() + policy.workSessionMaxHours * 60 * 60 * 1000);
    const work = await this.prisma.workSession.create({
      data: {
        deviceId: device.id,
        openedByUserId: actor.id,
        expiresAt,
        lastUserActivityAt: new Date(),
      },
    });

    await this.prisma.session.update({
      where: { id: actor.sessionId },
      data: {
        workSessionId: work.id,
        elevatedUntil: new Date(Date.now() + ELEVATION_TTL_MS),
        lastUserActivityAt: new Date(),
        lockedAt: null,
      },
    });

    await this.audit.log({
      action: AuditAction.WORK_SESSION_OPENED,
      actorUserId: actor.id,
      entityType: 'WorkSession',
      entityId: work.id,
      metadata: { deviceId: device.id, expiresAt },
      context,
    });

    return this.status(
      {
        ...actor,
        workSessionId: work.id,
        lockedAt: null,
        elevatedUntil: new Date(Date.now() + ELEVATION_TTL_MS),
      },
      deviceToken,
    );
  }

  async closeWorkSession(
    actor: AuthenticatedUser,
    reason: WorkSessionCloseReason,
    context: RequestContext,
  ): Promise<void> {
    if (!actor.workSessionId) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.workSession.updateMany({
        where: { id: actor.workSessionId!, closedAt: null },
        data: { closedAt: new Date(), closeReason: reason, lockedAt: new Date() },
      });
      await tx.session.updateMany({
        where: { workSessionId: actor.workSessionId!, revokedAt: null },
        data: { revokedAt: new Date(), lockedAt: new Date() },
      });
      await this.audit.log({
        action: AuditAction.WORK_SESSION_CLOSED,
        actorUserId: actor.id,
        entityType: 'WorkSession',
        entityId: actor.workSessionId,
        metadata: { reason },
        context,
        tx,
      });
    });
  }

  async lock(actor: AuthenticatedUser, context: RequestContext): Promise<void> {
    if (!actor.workSessionId) {
      throw new AppError('NO_WORK_SESSION', 'Нет активной рабочей сессии', {}, HttpStatus.CONFLICT);
    }
    const lockedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Lock every session bound to this work session (defense in depth for multi-tab).
      await tx.session.updateMany({
        where: { workSessionId: actor.workSessionId!, revokedAt: null },
        data: { lockedAt },
      });
      await tx.workSession.update({
        where: { id: actor.workSessionId! },
        data: { lockedAt },
      });
      await this.audit.log({
        action: AuditAction.WORKSTATION_LOCKED,
        actorUserId: actor.id,
        entityType: 'WorkSession',
        entityId: actor.workSessionId,
        context,
        tx,
      });
    });
  }

  /**
   * Server-side idle enforcement for protected API calls.
   * Does NOT refresh lastUserActivityAt (polling/API traffic must not extend the idle window).
   * @returns true when the workstation is locked after this check
   */
  async enforceIdleLockIfNeeded(actor: AuthenticatedUser): Promise<boolean> {
    if (!actor.workSessionId) {
      return false;
    }
    if (actor.lockedAt) {
      return true;
    }

    const policy = await this.policy.get();
    const work = await this.prisma.workSession.findUnique({ where: { id: actor.workSessionId } });
    if (!work || work.closedAt || work.expiresAt.getTime() <= Date.now()) {
      await this.closeWorkSession(actor, WorkSessionCloseReason.EXPIRED, {});
      return true;
    }

    const session = await this.prisma.session.findUnique({
      where: { id: actor.sessionId },
      select: { lastUserActivityAt: true, lockedAt: true },
    });
    if (session?.lockedAt) {
      return true;
    }

    const last = session?.lastUserActivityAt;
    const idleMs = policy.idleLockMinutes * 60 * 1000;
    if (last && Date.now() - last.getTime() > idleMs) {
      await this.lock(actor, {});
      return true;
    }
    return false;
  }

  /** Explicit user activity only — must not be called from background polling. */
  async recordUserActivity(actor: AuthenticatedUser): Promise<{ shouldLock: boolean }> {
    if (!actor.workSessionId || actor.lockedAt) {
      return { shouldLock: Boolean(actor.lockedAt) };
    }

    if (await this.enforceIdleLockIfNeeded(actor)) {
      return { shouldLock: true };
    }

    await this.prisma.session.update({
      where: { id: actor.sessionId },
      data: { lastUserActivityAt: new Date() },
    });
    await this.prisma.workSession.update({
      where: { id: actor.workSessionId },
      data: { lastUserActivityAt: new Date() },
    });
    return { shouldLock: false };
  }

  async listPinCandidates(deviceToken: string | undefined): Promise<PinCandidateDto[]> {
    const policy = await this.policy.get();
    if (!policy.pinEnabledOrg) return [];

    const device = await this.devices.resolveDevice(deviceToken);
    if (!device) return [];

    const work = await this.prisma.workSession.findFirst({
      where: {
        deviceId: device.id,
        closedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { openedAt: 'desc' },
    });
    if (!work) return [];

    let onlyUserId: string | undefined;
    if (!policy.allowEmployeeSwitch) {
      const holder = await this.prisma.session.findFirst({
        where: { workSessionId: work.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { userId: true },
      });
      if (holder) onlyUserId = holder.userId;
    }

    const allowlist =
      device.accessMode === DeviceAccessMode.SELECTED_USERS
        ? device.allowedUsers.map((u) => u.userId)
        : null;
    if (onlyUserId && allowlist && !allowlist.includes(onlyUserId)) {
      return [];
    }

    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        pinEnabled: true,
        pinHash: { not: null },
        ...(onlyUserId ? { id: onlyUserId } : allowlist ? { id: { in: allowlist } } : {}),
      },
      select: { id: true, name: true, role: true, pinLockedUntil: true },
      orderBy: { name: 'asc' },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role as Role,
    }));
  }

  async unlockWithPin(
    input: { userId: string; pin: string },
    deviceToken: string | undefined,
    context: RequestContext,
    response: Response,
  ) {
    const policy = await this.policy.get();
    if (!policy.pinEnabledOrg) {
      throw new AppError('PIN_DISABLED', 'PIN-вход отключён', {}, HttpStatus.FORBIDDEN);
    }
    if (!assertPinFormat(input.pin)) {
      throw new AppError('INVALID_PIN', 'Неверный PIN', {}, HttpStatus.UNAUTHORIZED);
    }

    const device = await this.devices.resolveDevice(deviceToken);
    if (!device) {
      throw new AppError('DEVICE_NOT_TRUSTED', 'Устройство не доверено', {}, HttpStatus.FORBIDDEN);
    }

    const work = await this.prisma.workSession.findFirst({
      where: {
        deviceId: device.id,
        closedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { openedAt: 'desc' },
    });
    if (!work) {
      throw new AppError(
        'NO_WORK_SESSION',
        'Рабочая сессия не активна — войдите по паролю',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    const fail = async (reason: string): Promise<never> => {
      await this.audit.log({
        action: AuditAction.PIN_UNLOCK_FAILED,
        actorUserId: null,
        entityType: 'User',
        entityId: input.userId,
        metadata: { reason, deviceId: device.id },
        context,
      });
      throw new AppError('INVALID_PIN', 'Неверный PIN', {}, HttpStatus.UNAUTHORIZED);
    };

    if (
      !user ||
      !user.isActive ||
      !user.pinEnabled ||
      !user.pinHash ||
      !this.devices.userAllowedOnDevice(device, user.id)
    ) {
      await fail('denied');
    }

    // Narrowed after fail(): user is active with a PIN hash.
    const pinUser = user!;
    const pinHash = pinUser.pinHash!;

    if (pinUser.pinLockedUntil && pinUser.pinLockedUntil.getTime() > Date.now()) {
      throw new AppError(
        'PIN_TEMP_LOCKED',
        'PIN временно заблокирован',
        { until: pinUser.pinLockedUntil.toISOString() },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const holder = await this.prisma.session.findFirst({
      where: { workSessionId: work.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { userId: true },
    });
    if (holder && holder.userId !== input.userId && !policy.allowEmployeeSwitch) {
      throw new AppError(
        'EMPLOYEE_SWITCH_DISABLED',
        'Переключение сотрудников отключено политикой',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    const ok = await verifyPin(pinHash, input.pin);
    if (!ok) {
      // Atomic increment across devices/parallel requests (uses OLD row values in both CASE arms).
      const lockUntil = new Date(Date.now() + policy.pinLockoutMinutes * 60 * 1000);
      await this.prisma.$executeRaw`
        UPDATE users
        SET
          "pinFailedAttempts" = CASE
            WHEN "pinFailedAttempts" + 1 >= ${policy.pinMaxAttempts} THEN 0
            ELSE "pinFailedAttempts" + 1
          END,
          "pinLockedUntil" = CASE
            WHEN "pinFailedAttempts" + 1 >= ${policy.pinMaxAttempts} THEN ${lockUntil}
            ELSE "pinLockedUntil"
          END
        WHERE id = ${pinUser.id}
      `;
      await fail('bad_pin');
    }

    // Serialize unlock/switch on the work session row to avoid dual active sessions.
    const auth = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM work_sessions WHERE id = ${work.id} FOR UPDATE`;

      const stillOpen = await tx.workSession.findFirst({
        where: { id: work.id, closedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!stillOpen) {
        throw new AppError(
          'NO_WORK_SESSION',
          'Рабочая сессия не активна — войдите по паролю',
          {},
          HttpStatus.FORBIDDEN,
        );
      }

      const freshUser = await tx.user.findUnique({ where: { id: pinUser.id } });
      if (
        !freshUser ||
        !freshUser.isActive ||
        !freshUser.pinEnabled ||
        !freshUser.pinHash ||
        (freshUser.pinLockedUntil && freshUser.pinLockedUntil.getTime() > Date.now())
      ) {
        throw new AppError('INVALID_PIN', 'Неверный PIN', {}, HttpStatus.UNAUTHORIZED);
      }

      const currentHolder = await tx.session.findFirst({
        where: { workSessionId: work.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { userId: true },
      });
      if (currentHolder && currentHolder.userId !== pinUser.id && !policy.allowEmployeeSwitch) {
        throw new AppError(
          'EMPLOYEE_SWITCH_DISABLED',
          'Переключение сотрудников отключено политикой',
          {},
          HttpStatus.FORBIDDEN,
        );
      }

      await tx.session.updateMany({
        where: { workSessionId: work.id, revokedAt: null },
        data: { revokedAt: new Date(), lockedAt: new Date() },
      });
      await tx.user.update({
        where: { id: pinUser.id },
        data: { pinFailedAttempts: 0, pinLockedUntil: null },
      });
      await tx.workSession.update({
        where: { id: work.id },
        data: { lockedAt: null, lastUserActivityAt: new Date() },
      });

      const created = await this.sessions.createSessionInTx(
        tx,
        {
          id: freshUser.id,
          name: freshUser.name,
          login: freshUser.login,
          email: freshUser.email,
          role: freshUser.role as Role,
        },
        context,
        {
          authStrength: AuthStrength.PIN,
          workSessionId: work.id,
          elevatedUntil: null,
        },
      );

      await this.audit.log({
        action: AuditAction.PIN_UNLOCK_SUCCESS,
        actorUserId: freshUser.id,
        entityType: 'WorkSession',
        entityId: work.id,
        metadata: { deviceId: device.id },
        context,
        tx,
      });
      if (currentHolder && currentHolder.userId !== freshUser.id) {
        await this.audit.log({
          action: AuditAction.EMPLOYEE_SWITCHED,
          actorUserId: freshUser.id,
          entityType: 'WorkSession',
          entityId: work.id,
          metadata: { fromUserId: currentHolder.userId, toUserId: freshUser.id },
          context,
          tx,
        });
      }

      return { created, user: freshUser };
    });

    this.sessions.setRefreshCookie(response, auth.created.refreshToken);
    return {
      accessToken: auth.created.accessToken,
      expiresIn: auth.created.expiresIn,
      user: {
        ...auth.created.user,
        authStrength: AuthStrength.PIN,
        elevated: false,
        workSessionActive: true,
        workstationLocked: false,
      },
      workSession: await this.status(
        {
          id: auth.user.id,
          name: auth.user.name,
          login: auth.user.login,
          email: auth.user.email,
          role: auth.user.role as Role,
          sessionId: auth.created.sessionId,
          isActive: true,
          authStrength: AuthStrength.PIN,
          elevatedUntil: null,
          workSessionId: work.id,
          lockedAt: null,
        },
        deviceToken,
      ),
    };
  }

  async forceLockDevice(
    actor: AuthenticatedUser,
    deviceId: string,
    context: RequestContext,
  ): Promise<void> {
    const { isElevated } = await import('../../common/auth/auth.types');
    if (!isElevated(actor)) {
      throw new AppError('STEP_UP_REQUIRED', 'Подтвердите пароль', {}, HttpStatus.FORBIDDEN);
    }
    await this.prisma.$transaction(async (tx) => {
      const open = await tx.workSession.findMany({
        where: { deviceId, closedAt: null },
        select: { id: true },
      });
      const ids = open.map((o) => o.id);
      if (ids.length) {
        await tx.workSession.updateMany({
          where: { id: { in: ids } },
          data: { lockedAt: new Date() },
        });
        await tx.session.updateMany({
          where: { workSessionId: { in: ids }, revokedAt: null },
          data: { lockedAt: new Date() },
        });
      }
      await this.audit.log({
        action: AuditAction.DEVICE_FORCE_LOCKED,
        actorUserId: actor.id,
        entityType: 'TrustedDevice',
        entityId: deviceId,
        metadata: { workSessions: ids.length },
        context,
        tx,
      });
    });
  }

  pinStatusForUser(user: {
    pinEnabled: boolean;
    pinHash: string | null;
    pinLockedUntil: Date | null;
  }) {
    return computePinStatus(user);
  }
}
