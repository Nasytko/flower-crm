import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction, DeviceAccessMode, type TrustedDeviceDto } from '@erp/shared';
import type { Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { isElevated } from '../../common/auth/auth.types';
import { generateOpaqueToken, hashToken } from '../../common/security/tokens';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SecurityPolicyService } from './security-policy.service';

export const DEVICE_COOKIE = 'erp_device';

@Injectable()
export class TrustedDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: SecurityPolicyService,
    private readonly config: AppConfigService,
  ) {}

  async list(currentToken?: string): Promise<TrustedDeviceDto[]> {
    const currentHash = currentToken ? hashToken(currentToken) : null;
    const rows = await this.prisma.trustedDevice.findMany({
      include: {
        createdBy: { select: { id: true, name: true } },
        allowedUsers: { select: { userId: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toDto(row, currentHash === row.tokenHash));
  }

  async trustCurrent(
    actor: AuthenticatedUser,
    input: {
      name: string;
      accessMode: DeviceAccessMode;
      allowedUserIds?: string[];
      trustDays?: number;
    },
    context: RequestContext,
    response: Response,
  ): Promise<TrustedDeviceDto> {
    this.assertElevated(actor);
    const name = input.name.trim();
    if (name.length < 2 || name.length > 100) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Укажите название устройства',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.accessMode === DeviceAccessMode.SELECTED_USERS) {
      if (!input.allowedUserIds?.length) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Выберите хотя бы одного сотрудника или режим «Все с PIN»',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const policy = await this.policy.get();
    const days = Math.min(90, Math.max(1, input.trustDays ?? policy.deviceTrustDays));
    const raw = generateOpaqueToken(32);
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const device = await this.prisma.$transaction(async (tx) => {
      const created = await tx.trustedDevice.create({
        data: {
          name,
          tokenHash,
          accessMode: input.accessMode,
          createdByUserId: actor.id,
          expiresAt,
          lastSeenAt: new Date(),
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent?.slice(0, 512) ?? null,
          allowedUsers:
            input.accessMode === DeviceAccessMode.SELECTED_USERS
              ? {
                  create: [...new Set(input.allowedUserIds!)].map((userId) => ({ userId })),
                }
              : undefined,
        },
        include: {
          createdBy: { select: { id: true, name: true } },
          allowedUsers: { select: { userId: true } },
        },
      });
      await this.audit.log({
        action: AuditAction.DEVICE_TRUSTED,
        actorUserId: actor.id,
        entityType: 'TrustedDevice',
        entityId: created.id,
        after: { name: created.name, accessMode: created.accessMode, expiresAt: created.expiresAt },
        context,
        tx,
      });
      return created;
    });

    this.setDeviceCookie(response, raw, expiresAt);
    return this.toDto(device, true);
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: {
      name?: string;
      accessMode?: DeviceAccessMode;
      allowedUserIds?: string[];
    },
    context: RequestContext,
  ): Promise<TrustedDeviceDto> {
    this.assertElevated(actor);
    const device = await this.prisma.trustedDevice.findUnique({
      where: { id },
      include: { allowedUsers: true },
    });
    if (!device || device.revokedAt) {
      throw new AppError('NOT_FOUND', 'Устройство не найдено', {}, HttpStatus.NOT_FOUND);
    }

    const accessMode = input.accessMode ?? (device.accessMode as DeviceAccessMode);
    if (accessMode === DeviceAccessMode.SELECTED_USERS) {
      const ids = input.allowedUserIds ?? device.allowedUsers.map((u) => u.userId);
      if (ids.length === 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Выберите хотя бы одного сотрудника или режим «Все с PIN»',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.accessMode !== undefined || input.allowedUserIds !== undefined) {
        await tx.trustedDeviceUser.deleteMany({ where: { deviceId: id } });
        if (accessMode === DeviceAccessMode.SELECTED_USERS) {
          const ids = [...new Set(input.allowedUserIds ?? [])];
          await tx.trustedDeviceUser.createMany({
            data: ids.map((userId) => ({ deviceId: id, userId })),
          });
        }
      }
      const row = await tx.trustedDevice.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
        },
        include: {
          createdBy: { select: { id: true, name: true } },
          allowedUsers: { select: { userId: true } },
        },
      });
      await this.audit.log({
        action: AuditAction.DEVICE_UPDATED,
        actorUserId: actor.id,
        entityType: 'TrustedDevice',
        entityId: id,
        after: { name: row.name, accessMode: row.accessMode },
        context,
        tx,
      });
      return row;
    });

    return this.toDto(updated, false);
  }

  async extend(
    actor: AuthenticatedUser,
    id: string,
    trustDays: number | undefined,
    context: RequestContext,
  ): Promise<TrustedDeviceDto> {
    this.assertElevated(actor);
    const policy = await this.policy.get();
    const days = Math.min(90, Math.max(1, trustDays ?? policy.deviceTrustDays));
    const device = await this.prisma.trustedDevice.findUnique({ where: { id } });
    if (!device || device.revokedAt) {
      throw new AppError('NOT_FOUND', 'Устройство не найдено', {}, HttpStatus.NOT_FOUND);
    }
    const base = Math.max(device.expiresAt.getTime(), Date.now());
    const expiresAt = new Date(base + days * 24 * 60 * 60 * 1000);
    const updated = await this.prisma.trustedDevice.update({
      where: { id },
      data: { expiresAt },
      include: {
        createdBy: { select: { id: true, name: true } },
        allowedUsers: { select: { userId: true } },
      },
    });
    await this.audit.log({
      action: AuditAction.DEVICE_EXTENDED,
      actorUserId: actor.id,
      entityType: 'TrustedDevice',
      entityId: id,
      metadata: { expiresAt },
      context,
    });
    return this.toDto(updated, false);
  }

  async revoke(
    actor: AuthenticatedUser,
    id: string,
    context: RequestContext,
    response?: Response,
    currentToken?: string,
  ): Promise<void> {
    this.assertElevated(actor);
    const device = await this.prisma.trustedDevice.findUnique({ where: { id } });
    if (!device || device.revokedAt) {
      throw new AppError('NOT_FOUND', 'Устройство не найдено', {}, HttpStatus.NOT_FOUND);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.trustedDevice.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      const openSessions = await tx.workSession.findMany({
        where: { deviceId: id, closedAt: null },
        select: { id: true },
      });
      const workIds = openSessions.map((s) => s.id);
      if (workIds.length) {
        await tx.workSession.updateMany({
          where: { id: { in: workIds } },
          data: { closedAt: new Date(), closeReason: 'DEVICE_REVOKED', lockedAt: new Date() },
        });
        await tx.session.updateMany({
          where: { workSessionId: { in: workIds }, revokedAt: null },
          data: { revokedAt: new Date(), lockedAt: new Date() },
        });
      }
      await this.audit.log({
        action: AuditAction.DEVICE_REVOKED,
        actorUserId: actor.id,
        entityType: 'TrustedDevice',
        entityId: id,
        metadata: { closedWorkSessions: workIds.length },
        context,
        tx,
      });
    });

    if (response && currentToken && hashToken(currentToken) === device.tokenHash) {
      this.clearDeviceCookie(response);
    }
  }

  async resolveDevice(rawToken: string | undefined) {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const device = await this.prisma.trustedDevice.findUnique({
      where: { tokenHash },
      include: { allowedUsers: { select: { userId: true } } },
    });
    if (!device || device.revokedAt) return null;
    if (device.expiresAt.getTime() <= Date.now()) return null;
    await this.prisma.trustedDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    return device;
  }

  userAllowedOnDevice(
    device: {
      accessMode: string;
      allowedUsers: Array<{ userId: string }>;
    },
    userId: string,
  ): boolean {
    if (device.accessMode === DeviceAccessMode.ALL_PIN_USERS) return true;
    return device.allowedUsers.some((u) => u.userId === userId);
  }

  setDeviceCookie(response: Response, raw: string, expiresAt: Date): void {
    response.cookie(DEVICE_COOKIE, raw, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/api/v1',
      expires: expiresAt,
    });
  }

  clearDeviceCookie(response: Response): void {
    response.clearCookie(DEVICE_COOKIE, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/api/v1',
    });
  }

  private assertElevated(actor: AuthenticatedUser): void {
    if (!isElevated(actor)) {
      throw new AppError(
        'STEP_UP_REQUIRED',
        'Для управления устройствами подтвердите пароль',
        {},
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private toDto(
    row: {
      id: string;
      name: string;
      accessMode: string;
      createdByUserId: string;
      createdBy: { id: string; name: string };
      expiresAt: Date;
      revokedAt: Date | null;
      lastSeenAt: Date | null;
      createdAt: Date;
      allowedUsers: Array<{ userId: string }>;
    },
    isCurrentDevice: boolean,
  ): TrustedDeviceDto {
    let status: TrustedDeviceDto['status'] = 'ACTIVE';
    if (row.revokedAt) status = 'REVOKED';
    else if (row.expiresAt.getTime() <= Date.now()) status = 'EXPIRED';
    return {
      id: row.id,
      name: row.name,
      accessMode: row.accessMode as DeviceAccessMode,
      allowedUserIds: row.allowedUsers.map((u) => u.userId),
      createdByUserId: row.createdByUserId,
      createdByName: row.createdBy.name,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      status,
      createdAt: row.createdAt.toISOString(),
      isCurrentDevice,
    };
  }
}
