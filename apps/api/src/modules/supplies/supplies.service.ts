import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  Permission,
  ProductType,
  Role,
  StockLotSource,
  StockMovementType,
  SupplyStatus,
  roleHasPermission,
  type SupplyDetail,
  type SupplyItemDto,
  type SupplyListItem,
  type SupplyListResult,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WarehouseLockService } from '../warehouse/warehouse-lock.service';
import { ReservationAllocationService } from '../warehouse/reservation-allocation.service';
import {
  CancelSupplyDto,
  CorrectSupplyDto,
  CreateSupplyDto,
  SupplyItemInputDto,
  SupplyQueryDto,
  UpdateSupplyDto,
} from './dto/supply.dto';
import {
  decimalToMoneyString,
  formatSupplyNumber,
  multiplyMoney,
  parseMoneyInput,
} from '../products/product-mapper';

type Tx = Prisma.TransactionClient;

const supplyDetailInclude = {
  items: { include: { product: { select: { id: true, name: true, type: true, isActive: true } } } },
  createdBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  paidBy: { select: { id: true, name: true } },
  correctionOf: { select: { id: true, number: true } },
  corrections: {
    where: { status: SupplyStatus.POSTED },
    select: { id: true, number: true },
    take: 1,
    orderBy: { postedAt: 'desc' as const },
  },
} as const;

/** List header + names; line aggregates loaded via SQL (no SupplyItem materialization). */
const supplyListSelect = {
  id: true,
  number: true,
  status: true,
  documentDate: true,
  supplierId: true,
  supplierName: true,
  paymentDueDate: true,
  paidAt: true,
  comment: true,
  correctionOfSupplyId: true,
  createdAt: true,
  postedAt: true,
  createdBy: { select: { name: true } },
  postedBy: { select: { name: true } },
  correctionOf: { select: { number: true } },
} as const;

export type SupplyLineAggregates = {
  itemCount: number;
  totalQuantity: number;
  totalAmount: Prisma.Decimal;
};

/** Exact JS equivalent of list SQL: SUM(quantity), SUM(unitPurchasePrice * quantity). */
export function aggregateSupplyLines(
  items: Array<{ quantity: number; unitPurchasePrice: Prisma.Decimal }>,
): SupplyLineAggregates {
  const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0);
  const totalAmount = items.reduce(
    (sum, i) => sum.plus(multiplyMoney(i.unitPurchasePrice, i.quantity)),
    new Prisma.Decimal(0),
  );
  return { itemCount: items.length, totalQuantity, totalAmount };
}

@Injectable()
export class SuppliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly warehouseLock: WarehouseLockService,
    private readonly reservationAllocation: ReservationAllocationService,
  ) {}

  async list(actor: AuthenticatedUser, query: SupplyQueryDto): Promise<SupplyListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const includePrices = this.canViewPurchasePrice(actor);

    const [total, rows] = await Promise.all([
      this.prisma.supply.count(),
      this.prisma.supply.findMany({
        select: supplyListSelect,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const aggregates = await this.loadListLineAggregates(rows.map((row) => row.id));

    return {
      items: rows.map((row) =>
        this.toListItem(
          row,
          aggregates.get(row.id) ?? {
            itemCount: 0,
            totalQuantity: 0,
            totalAmount: new Prisma.Decimal(0),
          },
          includePrices,
        ),
      ),
      total,
      page,
      limit,
    };
  }

  /**
   * Aggregate supply_items without materializing rows.
   * totalAmount = SUM(unitPurchasePrice * quantity) — same as multiplyMoney reduce.
   */
  private async loadListLineAggregates(supplyIds: string[]) {
    const map = new Map<string, SupplyLineAggregates>();
    if (supplyIds.length === 0) {
      return map;
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        supplyId: string;
        itemCount: number;
        totalQuantity: number;
        totalAmount: Prisma.Decimal | string;
      }>
    >`
      SELECT
        "supplyId",
        COUNT(*)::int AS "itemCount",
        COALESCE(SUM(quantity), 0)::int AS "totalQuantity",
        COALESCE(SUM("unitPurchasePrice" * quantity), 0) AS "totalAmount"
      FROM supply_items
      WHERE "supplyId" IN (${Prisma.join(supplyIds)})
      GROUP BY "supplyId"
    `;

    for (const row of rows) {
      map.set(row.supplyId, {
        itemCount: row.itemCount,
        totalQuantity: row.totalQuantity,
        totalAmount: new Prisma.Decimal(row.totalAmount),
      });
    }
    return map;
  }

  async getById(actor: AuthenticatedUser, id: string): Promise<SupplyDetail> {
    const row = await this.prisma.supply.findUnique({
      where: { id },
      include: supplyDetailInclude,
    });
    if (!row) {
      throw new AppError('SUPPLY_NOT_FOUND', 'Поставка не найдена', {}, HttpStatus.NOT_FOUND);
    }
    return this.toDetail(row, this.canViewPurchasePrice(actor));
  }

  async create(actor: AuthenticatedUser, dto: CreateSupplyDto, context: RequestContext) {
    const items = this.parseItems(dto.items);
    await this.assertFlowerProducts(items.map((i) => i.productId));
    const supplier = await this.requireActiveSupplier(dto.supplierId);

    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.nextSupplyNumber(tx);
      const supply = await tx.supply.create({
        data: {
          number,
          status: SupplyStatus.DRAFT,
          documentDate: new Date(dto.documentDate),
          supplierId: supplier.id,
          supplierName: supplier.name,
          paymentDueDate: dto.paymentDueDate ? new Date(dto.paymentDueDate) : null,
          comment: dto.comment ?? null,
          createdByUserId: actor.id,
          items: {
            create: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPurchasePrice: item.unitPurchasePrice,
            })),
          },
        },
        include: supplyDetailInclude,
      });

      await this.audit.log({
        action: AuditAction.SUPPLY_CREATED,
        actorUserId: actor.id,
        entityType: 'Supply',
        entityId: supply.id,
        metadata: { supplyId: supply.id, supplyNumber: supply.number },
        context,
        tx,
      });

      return supply;
    });

    return this.toDetail(created, this.canViewPurchasePrice(actor));
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateSupplyDto,
    context: RequestContext,
  ) {
    const supplier =
      dto.supplierId !== undefined ? await this.requireActiveSupplier(dto.supplierId) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockSupply(tx, id);
      if (locked.status !== SupplyStatus.DRAFT) {
        throw new AppError(
          'SUPPLY_NOT_EDITABLE',
          'Редактировать можно только черновик',
          {},
          HttpStatus.CONFLICT,
        );
      }

      if (dto.items) {
        const items = this.parseItems(dto.items);
        await this.assertFlowerProducts(
          items.map((i) => i.productId),
          tx,
        );
        await tx.supplyItem.deleteMany({ where: { supplyId: id } });
        await tx.supplyItem.createMany({
          data: items.map((item) => ({
            supplyId: id,
            productId: item.productId,
            quantity: item.quantity,
            unitPurchasePrice: item.unitPurchasePrice,
          })),
        });
      }

      await tx.supply.update({
        where: { id },
        data: {
          ...(dto.documentDate !== undefined ? { documentDate: new Date(dto.documentDate) } : {}),
          ...(supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
          ...(dto.paymentDueDate !== undefined
            ? { paymentDueDate: dto.paymentDueDate ? new Date(dto.paymentDueDate) : null }
            : {}),
          ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
        },
      });

      const full = await tx.supply.findUniqueOrThrow({
        where: { id },
        include: supplyDetailInclude,
      });

      await this.audit.log({
        action: AuditAction.SUPPLY_UPDATED,
        actorUserId: actor.id,
        entityType: 'Supply',
        entityId: id,
        metadata: { supplyId: id, supplyNumber: full.number },
        context,
        tx,
      });

      return full;
    });

    return this.toDetail(updated, this.canViewPurchasePrice(actor));
  }

  async post(actor: AuthenticatedUser, id: string, context: RequestContext) {
    // Correction drafts reverse the original in the same transaction.
    const existing = await this.prisma.supply.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('SUPPLY_NOT_FOUND', 'Поставка не найдена', {}, HttpStatus.NOT_FOUND);
    }
    if (existing.correctionOfSupplyId) {
      return this.postCorrection(actor, id, context);
    }

    const posted = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.beginStockMutation(tx);
      const supply = await this.lockSupply(tx, id);
      if (supply.status === SupplyStatus.POSTED) {
        throw new AppError(
          'SUPPLY_ALREADY_POSTED',
          'Поставка уже проведена',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (supply.status !== SupplyStatus.DRAFT) {
        throw new AppError(
          'SUPPLY_NOT_EDITABLE',
          'Провести можно только черновик',
          {},
          HttpStatus.CONFLICT,
        );
      }

      await this.postSupplyBody(tx, supply.id, actor.id, context);
      return tx.supply.findUniqueOrThrow({ where: { id }, include: supplyDetailInclude });
    });

    return this.toDetail(posted, this.canViewPurchasePrice(actor));
  }

  async createCorrection(
    actor: AuthenticatedUser,
    id: string,
    dto: CorrectSupplyDto,
    context: RequestContext,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      const original = await this.lockSupply(tx, id);
      if (original.status !== SupplyStatus.POSTED) {
        throw new AppError(
          'SUPPLY_CORRECTION_INVALID',
          'Исправлять можно только проведённую поставку',
          {},
          HttpStatus.CONFLICT,
        );
      }

      await this.assertLotsUntouched(tx, original.id);

      const items = await tx.supplyItem.findMany({ where: { supplyId: original.id } });
      if (items.length === 0) {
        throw new AppError('SUPPLY_EMPTY', 'Исходная поставка пуста', {}, HttpStatus.CONFLICT);
      }

      const number = await this.nextSupplyNumber(tx);
      const correction = await tx.supply.create({
        data: {
          number,
          status: SupplyStatus.DRAFT,
          documentDate: original.documentDate,
          supplierId: original.supplierId,
          supplierName: original.supplierName,
          paymentDueDate: original.paymentDueDate,
          comment: original.comment,
          correctionOfSupplyId: original.id,
          correctionReason: dto.reason,
          createdByUserId: actor.id,
          items: {
            create: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPurchasePrice: item.unitPurchasePrice,
            })),
          },
        },
        include: supplyDetailInclude,
      });

      await this.audit.log({
        action: AuditAction.SUPPLY_CORRECTION_CREATED,
        actorUserId: actor.id,
        entityType: 'Supply',
        entityId: correction.id,
        metadata: {
          supplyId: correction.id,
          supplyNumber: correction.number,
          correctionOfSupplyId: original.id,
          correctionOfNumber: original.number,
          reason: dto.reason,
        },
        context,
        tx,
      });

      return correction;
    });

    return this.toDetail(created, this.canViewPurchasePrice(actor));
  }

  /** Post a correction draft: reverse original (if still POSTED) then post correction. */
  async postCorrection(actor: AuthenticatedUser, id: string, context: RequestContext) {
    const posted = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.beginStockMutation(tx);
      const correction = await this.lockSupply(tx, id);
      if (correction.status !== SupplyStatus.DRAFT) {
        throw new AppError(
          'SUPPLY_NOT_EDITABLE',
          'Провести можно только черновик коррекции',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (!correction.correctionOfSupplyId) {
        throw new AppError(
          'SUPPLY_CORRECTION_INVALID',
          'Документ не является коррекцией',
          {},
          HttpStatus.CONFLICT,
        );
      }

      const original = await this.lockSupply(tx, correction.correctionOfSupplyId);
      if (original.status !== SupplyStatus.POSTED) {
        throw new AppError(
          'SUPPLY_CORRECTION_INVALID',
          'Исходная поставка уже не в статусе «Проведена»',
          {},
          HttpStatus.CONFLICT,
        );
      }

      await this.assertLotsUntouched(tx, original.id);
      await this.reversePostedSupply(tx, original, actor.id, context, correction.correctionReason);
      await this.postSupplyBody(tx, correction.id, actor.id, context);

      await this.audit.log({
        action: AuditAction.SUPPLY_CORRECTED,
        actorUserId: actor.id,
        entityType: 'Supply',
        entityId: correction.id,
        metadata: {
          supplyId: correction.id,
          supplyNumber: correction.number,
          correctionOfSupplyId: original.id,
          correctionOfNumber: original.number,
        },
        context,
        tx,
      });

      return tx.supply.findUniqueOrThrow({ where: { id }, include: supplyDetailInclude });
    });

    return this.toDetail(posted, this.canViewPurchasePrice(actor));
  }

  async cancel(
    actor: AuthenticatedUser,
    id: string,
    dto: CancelSupplyDto,
    context: RequestContext,
  ) {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.beginStockMutation(tx);
      const supply = await this.lockSupply(tx, id);
      if (supply.status !== SupplyStatus.POSTED) {
        throw new AppError(
          'SUPPLY_CORRECTION_INVALID',
          'Отменить можно только проведённую поставку',
          {},
          HttpStatus.CONFLICT,
        );
      }
      await this.assertLotsUntouched(tx, supply.id);
      await this.reversePostedSupply(tx, supply, actor.id, context, dto.reason);
      return tx.supply.findUniqueOrThrow({ where: { id }, include: supplyDetailInclude });
    });

    return this.toDetail(cancelled, this.canViewPurchasePrice(actor));
  }

  private async postSupplyBody(
    tx: Tx,
    supplyId: string,
    actorId: string,
    context: RequestContext,
  ): Promise<void> {
    const items = await tx.supplyItem.findMany({
      where: { supplyId },
      include: { product: true },
      orderBy: { productId: 'asc' },
    });
    if (items.length === 0) {
      throw new AppError('SUPPLY_EMPTY', 'Добавьте хотя бы одну позицию', {}, HttpStatus.CONFLICT);
    }

    for (const item of items) {
      if (item.product.type !== ProductType.FLOWER) {
        throw new AppError(
          'SUPPLY_SERVICE_NOT_ALLOWED',
          'В поставку нельзя добавить услугу',
          { productId: item.productId },
          HttpStatus.CONFLICT,
        );
      }
      if (!item.product.isActive) {
        throw new AppError(
          'PRODUCT_INACTIVE',
          'Нельзя провести поставку с неактивным товаром',
          { productId: item.productId },
          HttpStatus.CONFLICT,
        );
      }
    }

    const productIds = [...new Set(items.map((i) => i.productId))].sort();
    for (const productId of productIds) {
      await tx.$queryRaw`
        SELECT "productId" FROM product_stocks
        WHERE "productId" = ${productId}
        FOR UPDATE
      `;
    }

    const supply = await tx.supply.findUniqueOrThrow({ where: { id: supplyId } });
    const receivedAt = new Date();

    for (const item of items) {
      const stock = await tx.productStock.findUnique({ where: { productId: item.productId } });
      if (!stock) {
        throw new AppError(
          'STOCK_NOT_SUPPORTED',
          'Складская запись отсутствует',
          { productId: item.productId },
          HttpStatus.CONFLICT,
        );
      }
      const nextOnHand = stock.quantityOnHand + item.quantity;
      await tx.productStock.update({
        where: { productId: item.productId },
        data: { quantityOnHand: nextOnHand },
      });

      await tx.stockLot.create({
        data: {
          productId: item.productId,
          sourceType: StockLotSource.SUPPLY,
          supplyItemId: item.id,
          receivedQuantity: item.quantity,
          remainingQuantity: item.quantity,
          unitPurchasePrice: item.unitPurchasePrice,
          receivedAt,
        },
      });

      await tx.stockMovement.create({
        data: {
          productId: item.productId,
          type: StockMovementType.SUPPLY,
          quantity: item.quantity,
          balanceAfter: nextOnHand,
          sourceType: 'SUPPLY',
          sourceId: supplyId,
          comment: `Поставка ${formatSupplyNumber(supply.number)}`,
          createdByUserId: actorId,
        },
      });
    }

    await tx.supply.update({
      where: { id: supplyId },
      data: {
        status: SupplyStatus.POSTED,
        postedAt: receivedAt,
        postedByUserId: actorId,
      },
    });

    await this.audit.log({
      action: AuditAction.SUPPLY_POSTED,
      actorUserId: actorId,
      entityType: 'Supply',
      entityId: supplyId,
      metadata: { supplyId, supplyNumber: supply.number },
      context,
      tx,
    });

    await this.reservationAllocation.allocateAvailableForProducts(tx, productIds, context, actorId);
  }

  private async reversePostedSupply(
    tx: Tx,
    supply: { id: string; number: number },
    actorId: string,
    context: RequestContext,
    reason: string | null,
  ): Promise<void> {
    const items = await tx.supplyItem.findMany({
      where: { supplyId: supply.id },
      include: { lot: true },
      orderBy: { productId: 'asc' },
    });

    const productIds = [...new Set(items.map((i) => i.productId))].sort();
    for (const productId of productIds) {
      await tx.$queryRaw`
        SELECT "productId" FROM product_stocks
        WHERE "productId" = ${productId}
        FOR UPDATE
      `;
    }

    for (const item of items) {
      if (!item.lot) {
        throw new AppError(
          'SUPPLY_CORRECTION_INVALID',
          'Партия поставки не найдена',
          { supplyItemId: item.id },
          HttpStatus.CONFLICT,
        );
      }
      if (item.lot.remainingQuantity !== item.lot.receivedQuantity || item.lot.reversedAt) {
        throw new AppError(
          'SUPPLY_ALREADY_CONSUMED',
          'Поставка уже частично использована. Полная коррекция недоступна.',
          { supplyItemId: item.id },
          HttpStatus.CONFLICT,
        );
      }

      await tx.$queryRaw`
        SELECT id FROM stock_lots WHERE id = ${item.lot.id} FOR UPDATE
      `;

      const stock = await tx.productStock.findUniqueOrThrow({
        where: { productId: item.productId },
      });
      const nextOnHand = stock.quantityOnHand - item.quantity;
      if (nextOnHand < stock.quantityReserved || nextOnHand < 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          'Недостаточно остатка для отмены поставки',
          { productId: item.productId },
          HttpStatus.CONFLICT,
        );
      }

      await tx.productStock.update({
        where: { productId: item.productId },
        data: { quantityOnHand: nextOnHand },
      });

      await tx.stockLot.update({
        where: { id: item.lot.id },
        data: { remainingQuantity: 0, reversedAt: new Date() },
      });

      await tx.stockMovement.create({
        data: {
          productId: item.productId,
          type: StockMovementType.SUPPLY_REVERSAL,
          quantity: -item.quantity,
          balanceAfter: nextOnHand,
          sourceType: 'SUPPLY',
          sourceId: supply.id,
          comment: reason ?? `Отмена поставки ${formatSupplyNumber(supply.number)}`,
          createdByUserId: actorId,
        },
      });
    }

    await tx.supply.update({
      where: { id: supply.id },
      data: {
        status: SupplyStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledByUserId: actorId,
      },
    });

    await this.audit.log({
      action: AuditAction.SUPPLY_CANCELLED,
      actorUserId: actorId,
      entityType: 'Supply',
      entityId: supply.id,
      metadata: {
        supplyId: supply.id,
        supplyNumber: supply.number,
        reason,
      },
      context,
      tx,
    });
  }

  private async assertLotsUntouched(tx: Tx, supplyId: string): Promise<void> {
    const items = await tx.supplyItem.findMany({
      where: { supplyId },
      include: { lot: true },
    });
    for (const item of items) {
      if (!item.lot) continue;
      if (item.lot.remainingQuantity !== item.lot.receivedQuantity || item.lot.reversedAt) {
        throw new AppError(
          'SUPPLY_ALREADY_CONSUMED',
          'Поставка уже частично использована. Полная коррекция недоступна.',
          { supplyItemId: item.id },
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private async lockSupply(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: SupplyStatus;
        number: number;
        correctionOfSupplyId: string | null;
        documentDate: Date;
        supplierId: string;
        supplierName: string;
        paymentDueDate: Date | null;
        comment: string | null;
        correctionReason: string | null;
      }>
    >`
      SELECT id, status, number, "correctionOfSupplyId", "documentDate",
             "supplierId", "supplierName", "paymentDueDate", comment, "correctionReason"
      FROM supplies
      WHERE id = ${id}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new AppError('SUPPLY_NOT_FOUND', 'Поставка не найдена', {}, HttpStatus.NOT_FOUND);
    }
    return rows[0]!;
  }

  private async requireActiveSupplier(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) {
      throw new AppError('SUPPLIER_NOT_FOUND', 'Поставщик не найден', {}, HttpStatus.NOT_FOUND);
    }
    if (!supplier.isActive) {
      throw new AppError(
        'SUPPLIER_INACTIVE',
        'Нельзя выбрать неактивного поставщика',
        {},
        HttpStatus.CONFLICT,
      );
    }
    return supplier;
  }

  async markPaid(actor: AuthenticatedUser, id: string, context: RequestContext) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const supply = await this.lockSupply(tx, id);
      if (supply.status === SupplyStatus.CANCELLED) {
        throw new AppError(
          'SUPPLY_CANCELLED',
          'Нельзя отметить оплату у отменённой поставки',
          {},
          HttpStatus.CONFLICT,
        );
      }
      const full = await tx.supply.update({
        where: { id },
        data: {
          paidAt: new Date(),
          paidByUserId: actor.id,
        },
        include: supplyDetailInclude,
      });
      await this.audit.log({
        action: AuditAction.SUPPLY_MARKED_PAID,
        actorUserId: actor.id,
        entityType: 'Supply',
        entityId: id,
        metadata: { supplyId: id, supplyNumber: full.number },
        context,
        tx,
      });
      return full;
    });
    return this.toDetail(updated, this.canViewPurchasePrice(actor));
  }

  async markUnpaid(actor: AuthenticatedUser, id: string, context: RequestContext) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const supply = await this.lockSupply(tx, id);
      if (!supply) {
        throw new AppError('SUPPLY_NOT_FOUND', 'Поставка не найдена', {}, HttpStatus.NOT_FOUND);
      }
      const full = await tx.supply.update({
        where: { id },
        data: {
          paidAt: null,
          paidByUserId: null,
        },
        include: supplyDetailInclude,
      });
      await this.audit.log({
        action: AuditAction.SUPPLY_MARKED_UNPAID,
        actorUserId: actor.id,
        entityType: 'Supply',
        entityId: id,
        metadata: { supplyId: id, supplyNumber: full.number },
        context,
        tx,
      });
      return full;
    });
    return this.toDetail(updated, this.canViewPurchasePrice(actor));
  }

  private async nextSupplyNumber(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ nextval: bigint | number }>>`
      SELECT nextval('supply_number_seq') AS nextval
    `;
    return Number(rows[0]!.nextval);
  }

  private parseItems(items: SupplyItemInputDto[]) {
    return items.map((item) => {
      let unitPurchasePrice: Prisma.Decimal;
      try {
        const parsed = parseMoneyInput(item.unitPurchasePrice);
        if (parsed === null) {
          throw new Error('INVALID_MONEY');
        }
        unitPurchasePrice = parsed;
      } catch {
        throw new AppError(
          'VALIDATION_ERROR',
          'Некорректная закупочная цена',
          { productId: item.productId },
          HttpStatus.BAD_REQUEST,
        );
      }
      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPurchasePrice,
      };
    });
  }

  private async assertFlowerProducts(productIds: string[], tx?: Tx) {
    const client = tx ?? this.prisma;
    const products = await client.product.findMany({
      where: { id: { in: productIds } },
    });
    if (products.length !== new Set(productIds).size) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', {}, HttpStatus.NOT_FOUND);
    }
    for (const product of products) {
      if (product.type !== ProductType.FLOWER) {
        throw new AppError(
          'SUPPLY_SERVICE_NOT_ALLOWED',
          'В поставку нельзя добавить услугу',
          { productId: product.id },
          HttpStatus.CONFLICT,
        );
      }
      if (!product.isActive) {
        throw new AppError(
          'PRODUCT_INACTIVE',
          'Нельзя добавить неактивный товар',
          { productId: product.id },
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private canViewPurchasePrice(actor: AuthenticatedUser): boolean {
    return roleHasPermission(actor.role as Role, Permission.PURCHASE_PRICE_VIEW);
  }

  private toListItem(
    row: {
      id: string;
      number: number;
      status: SupplyStatus | string;
      documentDate: Date;
      supplierId: string;
      supplierName: string;
      paymentDueDate: Date | null;
      paidAt: Date | null;
      comment: string | null;
      correctionOfSupplyId: string | null;
      createdAt: Date;
      postedAt: Date | null;
      createdBy: { name: string };
      postedBy: { name: string } | null;
      correctionOf: { number: number } | null;
    },
    aggregates: SupplyLineAggregates,
    includePrices: boolean,
  ): SupplyListItem {
    const item: SupplyListItem = {
      id: row.id,
      number: row.number,
      numberLabel: formatSupplyNumber(row.number),
      status: row.status as SupplyStatus,
      documentDate: row.documentDate.toISOString().slice(0, 10),
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      paymentDueDate: row.paymentDueDate ? row.paymentDueDate.toISOString().slice(0, 10) : null,
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      isPaid: row.paidAt != null,
      comment: row.comment,
      correctionOfSupplyId: row.correctionOfSupplyId,
      correctionOfNumber: row.correctionOf?.number ?? null,
      itemCount: aggregates.itemCount,
      totalQuantity: aggregates.totalQuantity,
      createdByName: row.createdBy.name,
      postedByName: row.postedBy?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      postedAt: row.postedAt?.toISOString() ?? null,
    };
    if (includePrices) {
      item.totalAmount = decimalToMoneyString(aggregates.totalAmount) ?? '0.00';
    }
    return item;
  }

  private toDetail(
    row: {
      id: string;
      number: number;
      status: SupplyStatus | string;
      documentDate: Date;
      supplierId: string;
      supplierName: string;
      paymentDueDate: Date | null;
      paidAt: Date | null;
      comment: string | null;
      correctionOfSupplyId: string | null;
      correctionReason: string | null;
      createdByUserId: string;
      postedByUserId: string | null;
      cancelledByUserId: string | null;
      paidByUserId: string | null;
      createdAt: Date;
      updatedAt: Date;
      postedAt: Date | null;
      cancelledAt: Date | null;
      items: Array<{
        id: string;
        productId: string;
        quantity: number;
        unitPurchasePrice: Prisma.Decimal;
        product: { name: string };
      }>;
      createdBy: { name: string };
      postedBy: { name: string } | null;
      paidBy?: { name: string } | null;
      correctionOf: { id: string; number: number } | null;
      corrections: Array<{ id: string; number: number }>;
    },
    includePrices: boolean,
  ): SupplyDetail {
    const list = this.toListItem(row, aggregateSupplyLines(row.items), includePrices);
    const items: SupplyItemDto[] = row.items.map((item) => {
      const dto: SupplyItemDto = {
        id: item.id,
        productId: item.productId,
        productName: item.product.name,
        quantity: item.quantity,
      };
      if (includePrices) {
        dto.unitPurchasePrice = decimalToMoneyString(item.unitPurchasePrice) ?? '0.00';
        dto.lineTotal =
          decimalToMoneyString(multiplyMoney(item.unitPurchasePrice, item.quantity)) ?? '0.00';
      }
      return dto;
    });

    return {
      ...list,
      correctionReason: row.correctionReason,
      createdByUserId: row.createdByUserId,
      postedByUserId: row.postedByUserId,
      cancelledByUserId: row.cancelledByUserId,
      paidByUserId: row.paidByUserId,
      paidByName: row.paidBy?.name ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      correctedBySupplyId: row.corrections[0]?.id ?? null,
      correctedByNumber: row.corrections[0]?.number ?? null,
      items,
    };
  }
}
