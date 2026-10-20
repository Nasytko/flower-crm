import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import {
  AuditAction,
  SECURITY_POLICY_DEFAULTS,
  SECURITY_POLICY_LIMITS,
  type SecurityPolicyDto,
} from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { isElevated } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

@Injectable()
export class SecurityPolicyService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.securityPolicy.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  async get(): Promise<SecurityPolicyDto> {
    const row = await this.ensure();
    return this.toDto(row);
  }

  async ensure() {
    const existing = await this.prisma.securityPolicy.findUnique({ where: { id: 1 } });
    if (existing) return existing;
    return this.prisma.securityPolicy.create({ data: { id: 1 } });
  }

  async update(
    actor: AuthenticatedUser,
    patch: Partial<{
      pinEnabledOrg: boolean;
      deviceTrustDays: number;
      workSessionMaxHours: number;
      idleLockMinutes: number;
      pinMaxAttempts: number;
      pinLockoutMinutes: number;
      allowEmployeeSwitch: boolean;
    }>,
    context: RequestContext,
  ): Promise<SecurityPolicyDto> {
    if (!isElevated(actor)) {
      throw new AppError(
        'STEP_UP_REQUIRED',
        'Для изменения политики подтвердите пароль',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    const before = await this.ensure();
    const data = {
      pinEnabledOrg: patch.pinEnabledOrg ?? before.pinEnabledOrg,
      deviceTrustDays: clamp(
        patch.deviceTrustDays ?? before.deviceTrustDays,
        SECURITY_POLICY_LIMITS.deviceTrustDays.min,
        SECURITY_POLICY_LIMITS.deviceTrustDays.max,
      ),
      workSessionMaxHours: clamp(
        patch.workSessionMaxHours ?? before.workSessionMaxHours,
        SECURITY_POLICY_LIMITS.workSessionMaxHours.min,
        SECURITY_POLICY_LIMITS.workSessionMaxHours.max,
      ),
      idleLockMinutes: clamp(
        patch.idleLockMinutes ?? before.idleLockMinutes,
        SECURITY_POLICY_LIMITS.idleLockMinutes.min,
        SECURITY_POLICY_LIMITS.idleLockMinutes.max,
      ),
      pinMaxAttempts: clamp(
        patch.pinMaxAttempts ?? before.pinMaxAttempts,
        SECURITY_POLICY_LIMITS.pinMaxAttempts.min,
        SECURITY_POLICY_LIMITS.pinMaxAttempts.max,
      ),
      pinLockoutMinutes: clamp(
        patch.pinLockoutMinutes ?? before.pinLockoutMinutes,
        SECURITY_POLICY_LIMITS.pinLockoutMinutes.min,
        SECURITY_POLICY_LIMITS.pinLockoutMinutes.max,
      ),
      allowEmployeeSwitch: patch.allowEmployeeSwitch ?? before.allowEmployeeSwitch,
      // Never allow disabling password requirement for work session.
      requirePasswordForWorkSession: true,
      updatedByUserId: actor.id,
    };

    const updated = await this.prisma.securityPolicy.update({
      where: { id: 1 },
      data,
    });

    await this.audit.log({
      action: AuditAction.SECURITY_POLICY_UPDATED,
      actorUserId: actor.id,
      entityType: 'SecurityPolicy',
      entityId: '1',
      before: this.toDto(before),
      after: this.toDto(updated),
      context,
    });

    return this.toDto(updated);
  }

  toDto(row: {
    pinEnabledOrg: boolean;
    deviceTrustDays: number;
    workSessionMaxHours: number;
    idleLockMinutes: number;
    pinMaxAttempts: number;
    pinLockoutMinutes: number;
    allowEmployeeSwitch: boolean;
    requirePasswordForWorkSession: boolean;
    updatedAt: Date;
  }): SecurityPolicyDto {
    return {
      pinEnabledOrg: row.pinEnabledOrg,
      deviceTrustDays: row.deviceTrustDays,
      workSessionMaxHours: row.workSessionMaxHours,
      idleLockMinutes: row.idleLockMinutes,
      pinMaxAttempts: row.pinMaxAttempts,
      pinLockoutMinutes: row.pinLockoutMinutes,
      allowEmployeeSwitch: row.allowEmployeeSwitch,
      requirePasswordForWorkSession: true,
      pinLength: SECURITY_POLICY_DEFAULTS.pinLength,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
