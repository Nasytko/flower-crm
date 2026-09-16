import { Injectable } from '@nestjs/common';
import { AuditAction } from '@erp/shared';
import { Prisma } from '@erp/database';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeForAudit } from '../../common/security/sanitize';
import type { RequestContext } from '../../common/auth/auth.types';

export interface AuditLogInput {
  action: AuditAction | string;
  actorUserId?: string | null;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  context?: RequestContext;
  tx?: Prisma.TransactionClient;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditLogInput): Promise<void> {
    const data: Prisma.AuditLogCreateInput = {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before:
        input.before === undefined
          ? undefined
          : (sanitizeForAudit(input.before) as Prisma.InputJsonValue),
      after:
        input.after === undefined
          ? undefined
          : (sanitizeForAudit(input.after) as Prisma.InputJsonValue),
      metadata:
        input.metadata === undefined
          ? undefined
          : (sanitizeForAudit(input.metadata) as Prisma.InputJsonValue),
      ipAddress: input.context?.ipAddress ?? null,
      userAgent: input.context?.userAgent ?? null,
      requestId: input.context?.requestId ?? null,
      ...(input.actorUserId ? { actor: { connect: { id: input.actorUserId } } } : {}),
    };

    const client = input.tx ?? this.prisma;
    await client.auditLog.create({ data });
  }
}
