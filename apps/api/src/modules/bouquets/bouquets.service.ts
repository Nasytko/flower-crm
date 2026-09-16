import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  Permission,
  ProductType,
  Role,
  roleHasPermission,
  type BouquetDetail,
  type BouquetListResult,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseMoneyInput } from '../products/product-mapper';
import { type ProductCostSnapshot, toBouquetItemDto, toBouquetListItem } from './bouquet-calc';
import { BouquetQueryDto, CreateBouquetDto, UpdateBouquetDto } from './dto/bouquet.dto';

type Tx = Prisma.TransactionClient;

const bouquetInclude = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          type: true,
          unit: true,
          isActive: true,
          purchasePrice: true,
        },
      },
    },
    orderBy: [{ product: { type: 'asc' as const } }, { product: { name: 'asc' as const } }],
  },
};

@Injectable()
export class BouquetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthenticatedUser, query: BouquetQueryDto): Promise<BouquetListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const includePurchase = this.canViewPurchase(actor);
    const where = this.buildListWhere(query);

    const [total, rows] = await Promise.all([
      this.prisma.bouquet.count({ where }),
      this.prisma.bouquet.findMany({
        where,
        include: bouquetInclude,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const snapshots = await this.loadSnapshotsForBouquets(rows);
    return {
      items: rows.map((row) =>
        toBouquetListItem(
          {
            ...row,
            items: row.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              product: i.product,
            })),
          },
          snapshots,
          includePurchase,
        ),
      ),
      total,
      page,
      limit,
    };
  }

  async getById(actor: AuthenticatedUser, id: string): Promise<BouquetDetail> {
    const includePurchase = this.canViewPurchase(actor);
    const row = await this.prisma.bouquet.findUnique({
      where: { id },
      include: bouquetInclude,
    });
    if (!row) {
      throw new AppError('BOUQUET_NOT_FOUND', 'Букет не найден', {}, HttpStatus.NOT_FOUND);
    }
    return this.toDetail(row, includePurchase);
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateBouquetDto,
    context: RequestContext,
  ): Promise<BouquetDetail> {
    const salePrice = this.parseSalePrice(dto.salePrice);
    const items = this.normalizeItems(dto.items);

    const created = await this.prisma.$transaction(async (tx) => {
      await this.validateComposition(tx, items, { requireActive: true });

      const bouquet = await tx.bouquet.create({
        data: {
          name: dto.name.trim(),
          description: dto.description?.trim() ? dto.description.trim() : null,
          salePrice,
          isActive: true,
          version: 1,
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
            })),
          },
        },
        include: bouquetInclude,
      });

      await this.audit.log({
        action: AuditAction.BOUQUET_CREATED,
        actorUserId: actor.id,
        entityType: 'Bouquet',
        entityId: bouquet.id,
        after: this.auditSnapshot(bouquet),
        metadata: {
          bouquetId: bouquet.id,
          name: bouquet.name,
          itemCount: items.length,
        },
        context,
        tx,
      });

      return bouquet;
    });

    return this.toDetail(created, this.canViewPurchase(actor));
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateBouquetDto,
    context: RequestContext,
  ): Promise<BouquetDetail> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.bouquet.findUnique({
        where: { id },
        include: bouquetInclude,
      });
      if (!existing) {
        throw new AppError('BOUQUET_NOT_FOUND', 'Букет не найден', {}, HttpStatus.NOT_FOUND);
      }
      if (existing.version !== dto.expectedVersion) {
        throw new AppError(
          'BOUQUET_CONFLICT',
          'Букет был изменён другим пользователем. Обновите страницу и повторите.',
          { expectedVersion: dto.expectedVersion, currentVersion: existing.version },
          HttpStatus.CONFLICT,
        );
      }

      const before = this.auditSnapshot(existing);
      const scalarData: Prisma.BouquetUpdateManyMutationInput = {
        version: { increment: 1 },
      };

      if (dto.name !== undefined) scalarData.name = dto.name.trim();
      if (dto.description !== undefined) {
        scalarData.description = dto.description?.trim() ? dto.description.trim() : null;
      }
      if (dto.salePrice !== undefined) {
        scalarData.salePrice = this.parseSalePrice(dto.salePrice);
      }

      let nextItems: Array<{ productId: string; quantity: number }> | undefined;
      if (dto.items !== undefined) {
        nextItems = this.normalizeItems(dto.items);
        await this.validateComposition(tx, nextItems, { requireActive: true });
      }

      // Reactivation: require active products in (possibly updated) composition.
      if (dto.isActive === true && !existing.isActive) {
        const itemsForCheck =
          nextItems ??
          existing.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
          }));
        await this.validateComposition(tx, itemsForCheck, { requireActive: true });
        scalarData.isActive = true;
      } else if (dto.isActive === false) {
        scalarData.isActive = false;
      }

      // Atomic CAS first — claims the version before recipe mutation so concurrent
      // writers cannot interleave deleteMany/createMany under READ COMMITTED.
      const updatedCount = await tx.bouquet.updateMany({
        where: { id, version: dto.expectedVersion },
        data: scalarData,
      });
      if (updatedCount.count === 0) {
        const current = await tx.bouquet.findUnique({ where: { id }, select: { version: true } });
        if (!current) {
          throw new AppError('BOUQUET_NOT_FOUND', 'Букет не найден', {}, HttpStatus.NOT_FOUND);
        }
        throw new AppError(
          'BOUQUET_CONFLICT',
          'Букет был изменён другим пользователем. Обновите страницу и повторите.',
          { expectedVersion: dto.expectedVersion, currentVersion: current.version },
          HttpStatus.CONFLICT,
        );
      }

      if (nextItems !== undefined) {
        await tx.bouquetItem.deleteMany({ where: { bouquetId: id } });
        await tx.bouquetItem.createMany({
          data: nextItems.map((i) => ({
            bouquetId: id,
            productId: i.productId,
            quantity: i.quantity,
          })),
        });
      }

      const row = await tx.bouquet.findUniqueOrThrow({
        where: { id },
        include: bouquetInclude,
      });

      let action: AuditAction = AuditAction.BOUQUET_UPDATED;
      if (dto.isActive === false && existing.isActive) {
        action = AuditAction.BOUQUET_DEACTIVATED;
      } else if (dto.isActive === true && !existing.isActive) {
        action = AuditAction.BOUQUET_REACTIVATED;
      }

      await this.audit.log({
        action,
        actorUserId: actor.id,
        entityType: 'Bouquet',
        entityId: id,
        before,
        after: this.auditSnapshot(row),
        metadata: {
          bouquetId: id,
          name: row.name,
          expectedVersion: dto.expectedVersion,
          version: row.version,
        },
        context,
        tx,
      });

      return row;
    });

    return this.toDetail(updated, this.canViewPurchase(actor));
  }

  private async toDetail(
    row: {
      id: string;
      name: string;
      description: string | null;
      salePrice: Prisma.Decimal;
      isActive: boolean;
      version: number;
      createdAt: Date;
      updatedAt: Date;
      items: Array<{
        id: string;
        productId: string;
        quantity: number;
        product: {
          id: string;
          name: string;
          sku: string | null;
          type: string;
          unit: string;
          isActive: boolean;
          purchasePrice: Prisma.Decimal | null;
        };
      }>;
    },
    includePurchase: boolean,
  ): Promise<BouquetDetail> {
    const snapshots = await this.loadSnapshotsForBouquets([row]);
    const list = toBouquetListItem(
      {
        ...row,
        items: row.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          product: i.product,
        })),
      },
      snapshots,
      includePurchase,
    );
    return {
      ...list,
      items: row.items.map((item) =>
        toBouquetItemDto(item, snapshots.get(item.productId), includePurchase),
      ),
    };
  }

  private async loadSnapshotsForBouquets(
    bouquets: Array<{
      items: Array<{
        productId: string;
        product: {
          id: string;
          type: string;
          isActive: boolean;
          purchasePrice: Prisma.Decimal | null;
        };
      }>;
    }>,
  ): Promise<Map<string, ProductCostSnapshot>> {
    const productIds = [...new Set(bouquets.flatMap((b) => b.items.map((i) => i.productId)))];
    if (productIds.length === 0) {
      return new Map();
    }

    const [stocks, lots, products] = await Promise.all([
      this.prisma.productStock.findMany({
        where: { productId: { in: productIds } },
      }),
      this.prisma.stockLot.findMany({
        where: {
          productId: { in: productIds },
          remainingQuantity: { gt: 0 },
          reversedAt: null,
        },
        select: {
          productId: true,
          remainingQuantity: true,
          unitPurchasePrice: true,
        },
      }),
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          type: true,
          isActive: true,
          purchasePrice: true,
        },
      }),
    ]);

    const stockById = new Map(stocks.map((s) => [s.productId, s]));
    const lotsByProduct = new Map<string, typeof lots>();
    for (const lot of lots) {
      const arr = lotsByProduct.get(lot.productId) ?? [];
      arr.push(lot);
      lotsByProduct.set(lot.productId, arr);
    }

    const map = new Map<string, ProductCostSnapshot>();
    for (const product of products) {
      const stock = stockById.get(product.id);
      map.set(product.id, {
        productId: product.id,
        type: product.type,
        purchasePrice: product.purchasePrice,
        isActive: product.isActive,
        availableQuantity: stock ? stock.quantityOnHand - stock.quantityReserved : 0,
        lots: lotsByProduct.get(product.id) ?? [],
      });
    }
    return map;
  }

  private async validateComposition(
    tx: Tx,
    items: Array<{ productId: string; quantity: number }>,
    options: { requireActive: boolean },
  ): Promise<void> {
    if (items.length === 0) {
      throw new AppError(
        'BOUQUET_EMPTY',
        'Букет должен содержать хотя бы одну позицию',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    const ids = items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) {
      throw new AppError(
        'BOUQUET_DUPLICATE_COMPONENT',
        'Один товар нельзя добавить в состав дважды',
        {},
        HttpStatus.CONFLICT,
      );
    }

    const products = await tx.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true, isActive: true, name: true },
    });
    if (products.length !== ids.length) {
      throw new AppError(
        'BOUQUET_INACTIVE_PRODUCT',
        'Один или несколько товаров не найдены',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    let flowerCount = 0;
    for (const product of products) {
      if (options.requireActive && !product.isActive) {
        throw new AppError(
          'BOUQUET_INACTIVE_PRODUCT',
          `Нельзя использовать неактивный товар «${product.name}»`,
          { productId: product.id },
          HttpStatus.CONFLICT,
        );
      }
      if (product.type === ProductType.FLOWER) {
        flowerCount += 1;
      }
    }
    if (flowerCount === 0) {
      throw new AppError(
        'BOUQUET_FLOWER_REQUIRED',
        'В составе букета должен быть хотя бы один цветок',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private normalizeItems(
    items: Array<{ productId: string; quantity: number }>,
  ): Array<{ productId: string; quantity: number }> {
    return items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
    }));
  }

  private parseSalePrice(raw: string): Prisma.Decimal {
    try {
      const parsed = parseMoneyInput(raw);
      if (parsed === null) {
        throw new Error('INVALID_MONEY');
      }
      return parsed;
    } catch {
      throw new AppError(
        'BOUQUET_INVALID_PRICE',
        'Некорректная цена продажи',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private buildListWhere(query: BouquetQueryDto): Prisma.BouquetWhereInput {
    const where: Prisma.BouquetWhereInput = {};
    const active = query.isActive ?? 'true';
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;
    if (query.search?.trim()) {
      where.name = { contains: query.search.trim(), mode: 'insensitive' };
    }
    return where;
  }

  private canViewPurchase(actor: AuthenticatedUser): boolean {
    return roleHasPermission(actor.role as Role, Permission.PURCHASE_PRICE_VIEW);
  }

  private auditSnapshot(bouquet: {
    id: string;
    name: string;
    description: string | null;
    salePrice: Prisma.Decimal;
    isActive: boolean;
    version: number;
    items: Array<{ productId: string; quantity: number; product?: { name: string } }>;
  }) {
    return {
      id: bouquet.id,
      name: bouquet.name,
      description: bouquet.description,
      salePrice: bouquet.salePrice.toFixed(2),
      isActive: bouquet.isActive,
      version: bouquet.version,
      items: bouquet.items.map((i) => ({
        productId: i.productId,
        productName: i.product?.name,
        quantity: i.quantity,
      })),
    };
  }
}
