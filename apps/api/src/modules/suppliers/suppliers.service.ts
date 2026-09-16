import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  type SupplierListItem,
  type SupplierListResult,
} from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateSupplierDto, SupplierQueryDto, UpdateSupplierDto } from './dto/supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: SupplierQueryDto): Promise<SupplierListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where = this.buildWhere(query);

    const [total, rows] = await Promise.all([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({
        where,
        include: { _count: { select: { supplies: true } } },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((row) => this.toItem(row)),
      total,
      page,
      limit,
    };
  }

  async listActiveOptions(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.prisma.supplier.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return rows;
  }

  async getById(id: string): Promise<SupplierListItem> {
    const row = await this.prisma.supplier.findUnique({
      where: { id },
      include: { _count: { select: { supplies: true } } },
    });
    if (!row) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Поставщик не найден', {}, HttpStatus.NOT_FOUND);
    }
    return this.toItem(row);
  }

  async create(actor: AuthenticatedUser, dto: CreateSupplierDto, context: RequestContext) {
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.supplier.create({
          data: {
            name: dto.name.trim(),
            phone: dto.phone ?? null,
            comment: dto.comment ?? null,
          },
          include: { _count: { select: { supplies: true } } },
        });
        const item = this.toItem(row);
        await this.audit.log({
          action: AuditAction.SUPPLIER_CREATED,
          actorUserId: actor.id,
          entityType: 'Supplier',
          entityId: row.id,
          after: item,
          context,
          tx,
        });
        return item;
      });
      return created;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError(
          'SUPPLIER_NAME_EXISTS',
          'Поставщик с таким именем уже есть',
          {},
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateSupplierDto,
    context: RequestContext,
  ) {
    const current = await this.prisma.supplier.findUnique({
      where: { id },
      include: { _count: { select: { supplies: true } } },
    });
    if (!current) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Поставщик не найден', {}, HttpStatus.NOT_FOUND);
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.supplier.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          include: { _count: { select: { supplies: true } } },
        });

        const before = this.toItem(current);
        const after = this.toItem(row);
        const action =
          current.isActive && row.isActive === false
            ? AuditAction.SUPPLIER_DEACTIVATED
            : !current.isActive && row.isActive === true
              ? AuditAction.SUPPLIER_REACTIVATED
              : AuditAction.SUPPLIER_UPDATED;

        await this.audit.log({
          action,
          actorUserId: actor.id,
          entityType: 'Supplier',
          entityId: id,
          before,
          after,
          context,
          tx,
        });

        return after;
      });
      return updated;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError(
          'SUPPLIER_NAME_EXISTS',
          'Поставщик с таким именем уже есть',
          {},
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private buildWhere(query: SupplierQueryDto) {
    const where: {
      isActive?: boolean;
      name?: { contains: string; mode: 'insensitive' };
    } = {};

    const activeFilter = (query.isActive ?? 'true').toLowerCase();
    if (activeFilter === 'true') where.isActive = true;
    else if (activeFilter === 'false') where.isActive = false;

    if (query.search?.trim()) {
      where.name = { contains: query.search.trim(), mode: 'insensitive' };
    }
    return where;
  }

  private toItem(row: {
    id: string;
    name: string;
    phone: string | null;
    comment: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    _count: { supplies: number };
  }): SupplierListItem {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      comment: row.comment,
      isActive: row.isActive,
      supplyCount: row._count.supplies,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
