import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  Permission,
  ProductType,
  Role,
  StockMovementType,
  roleHasPermission,
  type ProductListResult,
  type StockMovementListItem,
  type StockMovementListResult,
  type StockWriteOffResult,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WarehouseLockService } from '../warehouse/warehouse-lock.service';
import { StockFifoService } from '../warehouse/stock-fifo.service';
import {
  CreateProductDto,
  ProductQueryDto,
  StockMovementsQueryDto,
  UpdateProductDto,
  WriteOffStockDto,
} from './dto/product.dto';
import { parseMoneyInput, toPublicProduct } from './product-mapper';

const productInclude = {
  stock: true,
  lots: {
    where: { remainingQuantity: { gt: 0 }, reversedAt: null },
    select: { remainingQuantity: true, unitPurchasePrice: true },
  },
} as const;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly warehouseLock: WarehouseLockService,
    private readonly stockFifo: StockFifoService,
  ) {}

  async list(actor: AuthenticatedUser, query: ProductQueryDto): Promise<ProductListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where = this.buildListWhere(query);
    const includePurchasePrice = this.canViewPurchasePrice(actor);

    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: includePurchasePrice ? productInclude : { stock: true },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((row) => toPublicProduct(row, { includePurchasePrice })),
      total,
      page,
      limit,
    };
  }

  async getById(actor: AuthenticatedUser, id: string) {
    const includePurchasePrice = this.canViewPurchasePrice(actor);
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: includePurchasePrice ? productInclude : { stock: true },
    });
    if (!product) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', {}, HttpStatus.NOT_FOUND);
    }
    return toPublicProduct(product, { includePurchasePrice });
  }

  async create(actor: AuthenticatedUser, dto: CreateProductDto, context: RequestContext) {
    let purchasePrice: Prisma.Decimal | null;
    let salePrice: Prisma.Decimal | null;
    try {
      purchasePrice = parseMoneyInput(dto.purchasePrice ?? null);
      salePrice = parseMoneyInput(dto.salePrice ?? null);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Некорректная цена', {}, HttpStatus.BAD_REQUEST);
    }

    if (dto.type === ProductType.FLOWER) {
      // FLOWER purchase cost lives on StockLot after supply posting.
      purchasePrice = null;
    }

    const sku = this.normalizeOptionalText(dto.sku);
    const description = this.normalizeOptionalText(dto.description);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            name: dto.name.trim(),
            sku,
            type: dto.type,
            description,
            unit: dto.unit,
            purchasePrice,
            salePrice,
          },
        });

        if (dto.type === ProductType.FLOWER) {
          await tx.productStock.create({
            data: {
              productId: product.id,
              quantityOnHand: 0,
              quantityReserved: 0,
            },
          });
        }

        const full = await tx.product.findUniqueOrThrow({
          where: { id: product.id },
          include: productInclude,
        });

        await this.audit.log({
          action: AuditAction.PRODUCT_CREATED,
          actorUserId: actor.id,
          entityType: 'Product',
          entityId: product.id,
          after: toPublicProduct(full, { includePurchasePrice: true }),
          context,
          tx,
        });

        return full;
      });

      return toPublicProduct(created, { includePurchasePrice: this.canViewPurchasePrice(actor) });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError('PRODUCT_SKU_ALREADY_EXISTS', 'SKU уже занят', {}, HttpStatus.CONFLICT);
      }
      throw error;
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateProductDto,
    context: RequestContext,
  ) {
    const current = await this.prisma.product.findUnique({
      where: { id },
      include: productInclude,
    });
    if (!current) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', {}, HttpStatus.NOT_FOUND);
    }

    let purchasePrice: Prisma.Decimal | null | undefined;
    let salePrice: Prisma.Decimal | null | undefined;
    try {
      if (dto.purchasePrice !== undefined) {
        if (current.type === ProductType.FLOWER) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Закупочная цена цветка задаётся в поставках',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        purchasePrice = parseMoneyInput(dto.purchasePrice);
      }
      if (dto.salePrice !== undefined) {
        salePrice = parseMoneyInput(dto.salePrice);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('VALIDATION_ERROR', 'Некорректная цена', {}, HttpStatus.BAD_REQUEST);
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.sku !== undefined ? { sku: this.normalizeOptionalText(dto.sku) } : {}),
            ...(dto.description !== undefined
              ? { description: this.normalizeOptionalText(dto.description) }
              : {}),
            ...(purchasePrice !== undefined ? { purchasePrice } : {}),
            ...(salePrice !== undefined ? { salePrice } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          include: productInclude,
        });

        const auditAction =
          current.isActive && product.isActive === false
            ? AuditAction.PRODUCT_DEACTIVATED
            : !current.isActive && product.isActive === true
              ? AuditAction.PRODUCT_REACTIVATED
              : AuditAction.PRODUCT_UPDATED;

        await this.audit.log({
          action: auditAction,
          actorUserId: actor.id,
          entityType: 'Product',
          entityId: id,
          before: toPublicProduct(current, { includePurchasePrice: true }),
          after: toPublicProduct(product, { includePurchasePrice: true }),
          context,
          tx,
        });

        return product;
      });

      return toPublicProduct(updated, { includePurchasePrice: this.canViewPurchasePrice(actor) });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError('PRODUCT_SKU_ALREADY_EXISTS', 'SKU уже занят', {}, HttpStatus.CONFLICT);
      }
      throw error;
    }
  }

  /**
   * Manual decrease only. Positive quantity in DTO → negative ledger delta.
   * Consumes StockLots FIFO and records allocations.
   */
  async writeOff(
    actor: AuthenticatedUser,
    productId: string,
    dto: WriteOffStockDto,
    context: RequestContext,
  ): Promise<StockWriteOffResult> {
    if (dto.quantity <= 0) {
      throw new AppError(
        'INVALID_WRITE_OFF',
        'Количество списания должно быть положительным',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);

        const product = await tx.product.findUnique({ where: { id: productId } });
        if (!product) {
          throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', {}, HttpStatus.NOT_FOUND);
        }
        if (product.type !== ProductType.FLOWER) {
          throw new AppError(
            'STOCK_NOT_SUPPORTED',
            'Списание доступно только для цветов',
            {},
            HttpStatus.CONFLICT,
          );
        }
        if (!product.isActive) {
          throw new AppError(
            'PRODUCT_INACTIVE',
            'Нельзя списывать неактивный товар',
            {},
            HttpStatus.CONFLICT,
          );
        }

        await tx.$queryRaw`
        SELECT "productId" FROM product_stocks
        WHERE "productId" = ${productId}
        FOR UPDATE
      `;

        const stock = await tx.productStock.findUnique({ where: { productId } });
        if (!stock) {
          throw new AppError(
            'STOCK_NOT_SUPPORTED',
            'Складская запись для товара отсутствует',
            {},
            HttpStatus.CONFLICT,
          );
        }

        const available = stock.quantityOnHand - stock.quantityReserved;
        if (dto.quantity > available) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            'Недостаточно свободного остатка. Часть товара зарезервирована под заказы.',
            {
              quantityOnHand: stock.quantityOnHand,
              quantityReserved: stock.quantityReserved,
              available,
              requested: dto.quantity,
            },
            HttpStatus.CONFLICT,
          );
        }

        const fifo = await this.stockFifo.consumeLots(tx, productId, dto.quantity, {
          requireFullCoverage: true,
        });
        const allocations = fifo.allocations;

        const nextOnHand = stock.quantityOnHand - dto.quantity;
        const updatedStock = await tx.productStock.update({
          where: { productId },
          data: { quantityOnHand: nextOnHand },
        });

        const movement = await tx.stockMovement.create({
          data: {
            productId,
            type: StockMovementType.MANUAL_WRITE_OFF,
            quantity: -dto.quantity,
            balanceAfter: nextOnHand,
            comment: dto.reason,
            createdByUserId: actor.id,
            allocations: {
              create: allocations.map((a) => ({
                stockLotId: a.stockLotId,
                quantity: a.quantity,
                unitPurchasePrice: a.unitPurchasePrice,
              })),
            },
          },
          include: { createdBy: { select: { id: true, name: true } } },
        });

        await this.audit.log({
          action: AuditAction.STOCK_WRITTEN_OFF,
          actorUserId: actor.id,
          entityType: 'Product',
          entityId: productId,
          metadata: {
            productId,
            quantity: dto.quantity,
            reason: dto.reason,
            beforeQuantity: stock.quantityOnHand,
            afterQuantity: nextOnHand,
            movementId: movement.id,
            lotAllocations: allocations.map((a) => ({
              stockLotId: a.stockLotId,
              quantity: a.quantity,
            })),
          },
          context,
          tx,
        });

        return { updatedStock, movement };
      },
      {
        maxWait: 15_000,
        timeout: 30_000,
      },
    );

    return {
      productId,
      quantityOnHand: result.updatedStock.quantityOnHand,
      quantityReserved: result.updatedStock.quantityReserved,
      availableQuantity: result.updatedStock.quantityOnHand - result.updatedStock.quantityReserved,
      movement: this.toMovementItem(result.movement),
    };
  }

  async listMovements(
    productId: string,
    query: StockMovementsQueryDto,
  ): Promise<StockMovementListResult> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Товар не найден', {}, HttpStatus.NOT_FOUND);
    }
    if (product.type !== ProductType.FLOWER) {
      throw new AppError(
        'STOCK_NOT_SUPPORTED',
        'История движений доступна только для цветов',
        {},
        HttpStatus.CONFLICT,
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where = { productId };

    const [total, rows] = await Promise.all([
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((row) => this.toMovementItem(row)),
      total,
      page,
      limit,
    };
  }

  private toMovementItem(row: {
    id: string;
    productId: string;
    type: string;
    quantity: number;
    balanceAfter: number;
    sourceType: string | null;
    sourceId: string | null;
    comment: string | null;
    createdByUserId: string | null;
    createdAt: Date;
    createdBy?: { id: string; name: string } | null;
  }): StockMovementListItem {
    return {
      id: row.id,
      productId: row.productId,
      type: row.type as StockMovementType,
      quantity: row.quantity,
      balanceAfter: row.balanceAfter,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      comment: row.comment,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdBy?.name ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private buildListWhere(query: ProductQueryDto): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = {};

    if (query.type) {
      where.type = query.type;
    }

    const activeFilter = (query.isActive ?? 'true').toLowerCase();
    if (activeFilter === 'true') {
      where.isActive = true;
    } else if (activeFilter === 'false') {
      where.isActive = false;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private canViewPurchasePrice(actor: AuthenticatedUser): boolean {
    return roleHasPermission(actor.role as Role, Permission.PURCHASE_PRICE_VIEW);
  }

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
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
