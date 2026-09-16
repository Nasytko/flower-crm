import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction, Role } from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import { hashPassword } from '../../common/security/password';
import { toPublicUser } from '../../common/security/sanitize';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { CreateEmployeeDto, ResetPasswordDto, UpdateEmployeeDto } from './dto/employee.dto';

const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  login: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  lastLoginUserAgent: true,
  createdAt: true,
  updatedAt: true,
} as const;

function normalizeEmail(email: string | null | undefined): string | null | undefined {
  if (email === undefined) return undefined;
  if (email === null) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const now = new Date();
    const users = await this.prisma.user.findMany({
      select: {
        ...USER_PUBLIC_SELECT,
        sessions: {
          where: { revokedAt: null, expiresAt: { gt: now } },
          select: { id: true },
        },
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return users.map(({ sessions, ...user }) =>
      toPublicUser(user, {
        hasActiveSession: sessions.length > 0,
        activeSessionCount: sessions.length,
      }),
    );
  }

  async getById(id: string) {
    const now = new Date();
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_PUBLIC_SELECT,
        sessions: {
          where: { revokedAt: null, expiresAt: { gt: now } },
          select: { id: true },
        },
      },
    });
    if (!user) {
      throw new AppError('NOT_FOUND', 'Сотрудник не найден', {}, HttpStatus.NOT_FOUND);
    }
    const { sessions, ...rest } = user;
    return toPublicUser(rest, {
      hasActiveSession: sessions.length > 0,
      activeSessionCount: sessions.length,
    });
  }

  async create(actor: AuthenticatedUser, dto: CreateEmployeeDto, context: RequestContext) {
    const existing = await this.prisma.user.findUnique({ where: { login: dto.login } });
    if (existing) {
      throw new AppError('LOGIN_TAKEN', 'Логин уже занят', {}, HttpStatus.CONFLICT);
    }

    const email = normalizeEmail(dto.email);
    if (email) {
      const emailTaken = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });
      if (emailTaken) {
        throw new AppError('EMAIL_TAKEN', 'Email уже занят', {}, HttpStatus.CONFLICT);
      }
    }

    const passwordHash = await hashPassword(dto.password);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: dto.name,
            login: dto.login,
            email: email ?? null,
            role: dto.role,
            passwordHash,
          },
          select: USER_PUBLIC_SELECT,
        });

        await this.audit.log({
          action: AuditAction.EMPLOYEE_CREATED,
          actorUserId: actor.id,
          entityType: 'User',
          entityId: user.id,
          after: toPublicUser(user),
          context,
          tx,
        });

        return user;
      });

      return toPublicUser(created);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.uniqueConflictError(error);
      }
      throw error;
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateEmployeeDto,
    context: RequestContext,
  ) {
    if (dto.login) {
      const taken = await this.prisma.user.findUnique({ where: { login: dto.login } });
      if (taken && taken.id !== id) {
        throw new AppError('LOGIN_TAKEN', 'Логин уже занят', {}, HttpStatus.CONFLICT);
      }
    }

    const email = normalizeEmail(dto.email);
    if (email) {
      const emailTaken = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, NOT: { id } },
      });
      if (emailTaken) {
        throw new AppError('EMAIL_TAKEN', 'Email уже занят', {}, HttpStatus.CONFLICT);
      }
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        // Serialize director demotions/deactivations so concurrent requests
        // cannot leave the shop with zero active directors.
        await tx.$queryRaw`
          SELECT id FROM users
          WHERE role = CAST('DIRECTOR' AS "Role") AND "isActive" = true
          FOR UPDATE
        `;

        const current = await tx.user.findUnique({
          where: { id },
          select: USER_PUBLIC_SELECT,
        });
        if (!current) {
          throw new AppError('NOT_FOUND', 'Сотрудник не найден', {}, HttpStatus.NOT_FOUND);
        }

        const nextRole = dto.role ?? (current.role as Role);
        const nextActive = dto.isActive ?? current.isActive;
        const demotingDirector =
          current.role === Role.DIRECTOR && (nextRole !== Role.DIRECTOR || nextActive === false);

        if (demotingDirector) {
          const activeDirectors = await tx.user.count({
            where: { role: Role.DIRECTOR, isActive: true },
          });
          if (activeDirectors <= 1) {
            throw new AppError(
              'LAST_DIRECTOR_PROTECTED',
              'Нельзя деактивировать или изменить роль последнего активного директора',
              {},
              HttpStatus.CONFLICT,
            );
          }
        }

        const user = await tx.user.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.login !== undefined ? { login: dto.login } : {}),
            ...(dto.email !== undefined ? { email: email ?? null } : {}),
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          select: USER_PUBLIC_SELECT,
        });

        if (current.isActive && user.isActive === false) {
          await tx.session.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await this.audit.log({
            action: AuditAction.EMPLOYEE_DEACTIVATED,
            actorUserId: actor.id,
            entityType: 'User',
            entityId: id,
            before: toPublicUser(current),
            after: toPublicUser(user),
            context,
            tx,
          });
        } else if (!current.isActive && user.isActive === true) {
          await this.audit.log({
            action: AuditAction.EMPLOYEE_REACTIVATED,
            actorUserId: actor.id,
            entityType: 'User',
            entityId: id,
            before: toPublicUser(current),
            after: toPublicUser(user),
            context,
            tx,
          });
        } else {
          await this.audit.log({
            action: AuditAction.EMPLOYEE_UPDATED,
            actorUserId: actor.id,
            entityType: 'User',
            entityId: id,
            before: toPublicUser(current),
            after: toPublicUser(user),
            context,
            tx,
          });
        }

        return user;
      });

      return toPublicUser(updated);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (this.isUniqueViolation(error)) {
        throw this.uniqueConflictError(error);
      }
      throw error;
    }
  }

  async deactivate(actor: AuthenticatedUser, id: string, context: RequestContext) {
    return this.update(actor, id, { isActive: false }, context);
  }

  async resetPassword(
    actor: AuthenticatedUser,
    id: string,
    dto: ResetPasswordDto,
    context: RequestContext,
  ): Promise<void> {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, login: true },
    });
    if (!current) {
      throw new AppError('NOT_FOUND', 'Сотрудник не найден', {}, HttpStatus.NOT_FOUND);
    }

    const passwordHash = await hashPassword(dto.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash },
      });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        action: AuditAction.PASSWORD_RESET,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: id,
        metadata: { targetLogin: current.login },
        context,
        tx,
      });
      await this.audit.log({
        action: AuditAction.SESSION_REVOKED,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: id,
        metadata: { reason: 'password_reset' },
        context,
        tx,
      });
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  private uniqueConflictError(error: unknown): AppError {
    const target = (error as { meta?: { target?: string | string[] } }).meta?.target;
    const fields = Array.isArray(target) ? target : target ? [target] : [];
    if (fields.some((field) => field.toLowerCase().includes('email'))) {
      return new AppError('EMAIL_TAKEN', 'Email уже занят', {}, HttpStatus.CONFLICT);
    }
    return new AppError('LOGIN_TAKEN', 'Логин уже занят', {}, HttpStatus.CONFLICT);
  }
}
