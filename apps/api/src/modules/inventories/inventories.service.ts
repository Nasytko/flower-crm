import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  InventoryStatus,
  ProductType,
  StockLotSource,
  StockMovementType,
  type ActiveInventoryInfo,
  type InventoryDetail,
  type InventoryItemDto,
  type InventoryListResult,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WarehouseLockService } from '../warehouse/warehouse-lock.service';
import { StockFifoService } from '../warehouse/stock-fifo.service';
import { ReservationAllocationService } from '../warehouse/reservation-allocation.service';
import {
  BatchUpdateInventoryItemsDto,
  CancelInventoryDto,
  CreateInventoryDto,
  InventoryQueryDto,
  UpdateInventoryItemDto,
} from './dto/inventory.dto';
import {
  formatInventoryNumber,
  toActiveInventoryInfo,
  toInventoryDetail,
  toInventoryItemDto,
  toInventoryListItem,
} from './inventory-mapper';

type Tx = Prisma.TransactionClient;

const sessionDetailInclude = {
  createdBy: { select: { id: true, name: true } },
  completedBy: { select: { id: true, name: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      countedBy: { select: { id: true, name: true } },
    },
    orderBy: { product: { name: 'asc' as const } },
  },
} as const;

/** List needs session header + user names only; item aggregates load separately. */
const sessionListSelect = {
  id: true,
  number: true,
  status: true,
  comment: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  createdBy: { select: { name: true } },
  completedBy: { select: { name: true } },
} as const;

const EMPTY_LIST_SUMMARY = {
  itemCount: 0,
  countedItemCount: 0,
  differenceItemCount: 0,
} as const;

@Injectable()
export class InventoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly warehouseLock: WarehouseLockService,
    private readonly stockFifo: StockFifoService,
    private readonly reservationAllocation: ReservationAllocationService,
  ) {}

  async list(_actor: AuthenticatedUser, query: InventoryQueryDto): Promise<InventoryListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const [total, rows] = await Promise.all([
      this.prisma.inventorySession.count(),
      this.prisma.inventorySession.findMany({
        select: sessionListSelect,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const summaries = await this.loadListItemSummaries(rows.map((row) => row.id));

    return {
      items: rows.map((row) =>
        toInventoryListItem(row, summaries.get(row.id) ?? EMPTY_LIST_SUMMARY),
      ),
      total,
      page,
      limit,
    };
  }

  /**
   * Aggregate inventory_items without materializing product/counter joins.
   * FILTER semantics match summarizeItems() counts.
   */
  private async loadListItemSummaries(sessionIds: string[]) {
    const map = new Map<
      string,
      {
        itemCount: number;
        countedItemCount: number;
        differenceItemCount: number;
      }
    >();
    if (sessionIds.length === 0) {
      return map;
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        inventorySessionId: string;
        itemCount: number;
        countedItemCount: number;
        differenceItemCount: number;
      }>
    >`
      SELECT
        "inventorySessionId",
        COUNT(*)::int AS "itemCount",
        COUNT(*) FILTER (WHERE "countedQuantity" IS NOT NULL)::int AS "countedItemCount",
        COUNT(*) FILTER (
          WHERE "countedQuantity" IS NOT NULL
            AND "countedQuantity" <> "expectedQuantity"
        )::int AS "differenceItemCount"
      FROM inventory_items
      WHERE "inventorySessionId" IN (${Prisma.join(sessionIds)})
      GROUP BY "inventorySessionId"
    `;

    for (const row of rows) {
      map.set(row.inventorySessionId, {
        itemCount: row.itemCount,
        countedItemCount: row.countedItemCount,
        differenceItemCount: row.differenceItemCount,
      });
    }
    return map;
  }

  async getActive(_actor: AuthenticatedUser): Promise<ActiveInventoryInfo | null> {
    const row = await this.prisma.inventorySession.findFirst({
      where: { status: InventoryStatus.IN_PROGRESS },
      include: sessionDetailInclude,
    });
    // Explicit null JSON (Nest may omit body for bare `return null` in some setups).
    return row ? toActiveInventoryInfo(row) : null;
  }

  async getById(_actor: AuthenticatedUser, id: string): Promise<InventoryDetail> {
    const row = await this.prisma.inventorySession.findUnique({
      where: { id },
      include: sessionDetailInclude,
    });
    if (!row) {
      throw new AppError(
        'INVENTORY_NOT_FOUND',
        'Инвентаризация не найдена',
        {},
        HttpStatus.NOT_FOUND,
      );
    }
    return toInventoryDetail(row);
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateInventoryDto,
    context: RequestContext,
  ): Promise<InventoryDetail> {
    const created = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.acquireWarehouseLock(tx);
      await this.assertNoOpenInventory(tx);

      const number = await this.nextInventoryNumber(tx);
      const session = await tx.inventorySession.create({
        data: {
          number,
          status: InventoryStatus.DRAFT,
          comment: dto.comment ?? null,
          createdByUserId: actor.id,
        },
        include: sessionDetailInclude,
      });

      await this.audit.log({
        action: AuditAction.INVENTORY_CREATED,
        actorUserId: actor.id,
        entityType: 'InventorySession',
        entityId: session.id,
        metadata: {
          inventoryId: session.id,
          inventoryNumber: session.number,
          numberLabel: formatInventoryNumber(session.number),
        },
        context,
        tx,
      });

      return session;
    });

    return toInventoryDetail(created);
  }

  /**
   * Create DRAFT then start in one transaction — seamless UX entry point.
   */
  async createAndStart(
    actor: AuthenticatedUser,
    dto: CreateInventoryDto,
    context: RequestContext,
  ): Promise<InventoryDetail> {
    const started = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.acquireWarehouseLock(tx);
      await this.assertNoOpenInventory(tx);

      const number = await this.nextInventoryNumber(tx);
      const session = await tx.inventorySession.create({
        data: {
          number,
          status: InventoryStatus.DRAFT,
          comment: dto.comment ?? null,
          createdByUserId: actor.id,
        },
      });

      await this.audit.log({
        action: AuditAction.INVENTORY_CREATED,
        actorUserId: actor.id,
        entityType: 'InventorySession',
        entityId: session.id,
        metadata: {
          inventoryId: session.id,
          inventoryNumber: session.number,
          numberLabel: formatInventoryNumber(session.number),
        },
        context,
        tx,
      });

      // Inline start under same warehouse lock.
      const products = await tx.product.findMany({
        where: {
          type: ProductType.FLOWER,
          stock: { isNot: null },
          OR: [
            { isActive: true },
            { stock: { quantityOnHand: { gt: 0 } } },
            { stock: { quantityReserved: { gt: 0 } } },
          ],
        },
        include: { stock: true },
        orderBy: { id: 'asc' },
      });

      for (const product of products) {
        await tx.$queryRaw`
          SELECT "productId" FROM product_stocks
          WHERE "productId" = ${product.id}
          FOR UPDATE
        `;
      }

      const startedAt = new Date();
      if (products.length > 0) {
        await tx.inventoryItem.createMany({
          data: products.map((product) => ({
            inventorySessionId: session.id,
            productId: product.id,
            expectedQuantity: product.stock?.quantityOnHand ?? 0,
          })),
        });
      }

      await tx.inventorySession.update({
        where: { id: session.id },
        data: {
          status: InventoryStatus.IN_PROGRESS,
          startedAt,
        },
      });

      await this.audit.log({
        action: AuditAction.INVENTORY_STARTED,
        actorUserId: actor.id,
        entityType: 'InventorySession',
        entityId: session.id,
        metadata: {
          inventoryId: session.id,
          inventoryNumber: session.number,
          numberLabel: formatInventoryNumber(session.number),
          itemCount: products.length,
        },
        context,
        tx,
      });

      return tx.inventorySession.findUniqueOrThrow({
        where: { id: session.id },
        include: sessionDetailInclude,
      });
    });

    return toInventoryDetail(started);
  }

  async start(
    actor: AuthenticatedUser,
    id: string,
    context: RequestContext,
  ): Promise<InventoryDetail> {
    const started = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.acquireWarehouseLock(tx);

      const session = await this.lockSession(tx, id);
      if (session.status === InventoryStatus.IN_PROGRESS) {
        throw new AppError(
          'INVENTORY_ALREADY_STARTED',
          'Инвентаризация уже начата',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (session.status !== InventoryStatus.DRAFT) {
        throw new AppError(
          'INVENTORY_NOT_EDITABLE',
          'Начать можно только черновик',
          {},
          HttpStatus.CONFLICT,
        );
      }

      const other = await tx.inventorySession.findFirst({
        where: { status: InventoryStatus.IN_PROGRESS, NOT: { id } },
        select: { id: true, number: true },
      });
      if (other) {
        throw new AppError(
          'INVENTORY_IN_PROGRESS',
          `Уже идёт инвентаризация ${formatInventoryNumber(other.number)}`,
          {
            inventoryId: other.id,
            inventoryNumber: other.number,
            numberLabel: formatInventoryNumber(other.number),
          },
          HttpStatus.CONFLICT,
        );
      }

      const products = await tx.product.findMany({
        where: {
          type: ProductType.FLOWER,
          stock: { isNot: null },
          OR: [
            { isActive: true },
            { stock: { quantityOnHand: { gt: 0 } } },
            { stock: { quantityReserved: { gt: 0 } } },
          ],
        },
        include: { stock: true },
        orderBy: { id: 'asc' },
      });

      const productIds = products.map((p) => p.id);
      for (const productId of productIds) {
        await tx.$queryRaw`
          SELECT "productId" FROM product_stocks
          WHERE "productId" = ${productId}
          FOR UPDATE
        `;
      }

      const startedAt = new Date();
      if (products.length > 0) {
        await tx.inventoryItem.createMany({
          data: products.map((product) => ({
            inventorySessionId: id,
            productId: product.id,
            expectedQuantity: product.stock?.quantityOnHand ?? 0,
          })),
        });
      }

      await tx.inventorySession.update({
        where: { id },
        data: {
          status: InventoryStatus.IN_PROGRESS,
          startedAt,
        },
      });

      await this.audit.log({
        action: AuditAction.INVENTORY_STARTED,
        actorUserId: actor.id,
        entityType: 'InventorySession',
        entityId: id,
        metadata: {
          inventoryId: id,
          inventoryNumber: session.number,
          numberLabel: formatInventoryNumber(session.number),
          itemCount: products.length,
        },
        context,
        tx,
      });

      return tx.inventorySession.findUniqueOrThrow({
        where: { id },
        include: sessionDetailInclude,
      });
    });

    return toInventoryDetail(started);
  }

  async updateItem(
    actor: AuthenticatedUser,
    inventoryId: string,
    itemId: string,
    dto: UpdateInventoryItemDto,
    _context: RequestContext,
  ): Promise<InventoryItemDto> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, inventoryId);
      this.assertInProgress(session);

      const item = await tx.inventoryItem.findFirst({
        where: { id: itemId, inventorySessionId: inventoryId },
      });
      if (!item) {
        throw new AppError(
          'INVENTORY_ITEM_NOT_FOUND',
          'Позиция инвентаризации не найдена',
          {},
          HttpStatus.NOT_FOUND,
        );
      }

      const updated = await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          countedQuantity: dto.countedQuantity,
          countedByUserId: actor.id,
          countedAt: new Date(),
        },
        include: {
          product: { select: { id: true, name: true, sku: true } },
          countedBy: { select: { id: true, name: true } },
        },
      });

      return toInventoryItemDto(updated);
    });
  }

  async updateItemsBatch(
    actor: AuthenticatedUser,
    inventoryId: string,
    dto: BatchUpdateInventoryItemsDto,
    _context: RequestContext,
  ): Promise<InventoryDetail> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, inventoryId);
      this.assertInProgress(session);

      const now = new Date();
      for (const entry of dto.items) {
        const item = await tx.inventoryItem.findFirst({
          where: { id: entry.itemId, inventorySessionId: inventoryId },
        });
        if (!item) {
          throw new AppError(
            'INVENTORY_ITEM_NOT_FOUND',
            'Позиция инвентаризации не найдена',
            { itemId: entry.itemId },
            HttpStatus.NOT_FOUND,
          );
        }
        await tx.inventoryItem.update({
          where: { id: entry.itemId },
          data: {
            countedQuantity: entry.countedQuantity,
            countedByUserId: actor.id,
            countedAt: now,
          },
        });
      }

      return tx.inventorySession.findUniqueOrThrow({
        where: { id: inventoryId },
        include: sessionDetailInclude,
      });
    });

    return toInventoryDetail(updated);
  }

  async complete(
    actor: AuthenticatedUser,
    id: string,
    context: RequestContext,
  ): Promise<InventoryDetail> {
    const completed = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.acquireWarehouseLock(tx);

      const session = await this.lockSession(tx, id);
      if (session.status === InventoryStatus.COMPLETED) {
        throw new AppError(
          'INVENTORY_ALREADY_COMPLETED',
          'Инвентаризация уже завершена',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (session.status !== InventoryStatus.IN_PROGRESS) {
        throw new AppError(
          'INVENTORY_NOT_EDITABLE',
          'Завершить можно только инвентаризацию в процессе',
          {},
          HttpStatus.CONFLICT,
        );
      }

      const items = await tx.inventoryItem.findMany({
        where: { inventorySessionId: id },
        include: { product: { select: { id: true, name: true } } },
        orderBy: { productId: 'asc' },
      });

      const incomplete = items.filter((i) => i.countedQuantity === null);
      if (incomplete.length > 0) {
        throw new AppError(
          'INVENTORY_INCOMPLETE',
          'Не все позиции посчитаны',
          {
            missingCount: incomplete.length,
            missingItemIds: incomplete.slice(0, 50).map((i) => i.id),
            missingProductNames: incomplete.slice(0, 20).map((i) => i.product.name),
          },
          HttpStatus.CONFLICT,
        );
      }

      for (const item of items) {
        await tx.$queryRaw`
          SELECT "productId" FROM product_stocks
          WHERE "productId" = ${item.productId}
          FOR UPDATE
        `;
      }

      let differenceItemCount = 0;
      let positiveQuantity = 0;
      let negativeQuantity = 0;
      const completedAt = new Date();
      const surplusProductIds: string[] = [];

      for (const item of items) {
        const counted = item.countedQuantity!;
        const stock = await tx.productStock.findUnique({ where: { productId: item.productId } });
        if (!stock) {
          throw new AppError(
            'STOCK_NOT_SUPPORTED',
            'Складская запись отсутствует',
            { productId: item.productId },
            HttpStatus.CONFLICT,
          );
        }

        if (stock.quantityOnHand !== item.expectedQuantity) {
          throw new AppError(
            'INVENTORY_STOCK_CHANGED',
            'Остаток изменился после начала инвентаризации',
            {
              productId: item.productId,
              expectedQuantity: item.expectedQuantity,
              currentOnHand: stock.quantityOnHand,
            },
            HttpStatus.CONFLICT,
          );
        }

        if (counted < stock.quantityReserved) {
          throw new AppError(
            'INVENTORY_BELOW_RESERVED',
            'Фактический остаток меньше зарезервированного',
            {
              productId: item.productId,
              countedQuantity: counted,
              quantityReserved: stock.quantityReserved,
            },
            HttpStatus.CONFLICT,
          );
        }

        const difference = counted - item.expectedQuantity;
        if (difference === 0) {
          continue;
        }

        differenceItemCount += 1;
        if (difference > 0) positiveQuantity += difference;
        if (difference < 0) negativeQuantity += Math.abs(difference);

        const nextOnHand = counted;
        await tx.productStock.update({
          where: { productId: item.productId },
          data: { quantityOnHand: nextOnHand },
        });

        const comment = `${formatInventoryNumber(session.number)}: ожидалось ${item.expectedQuantity}, фактически ${counted}`;

        if (difference < 0) {
          const consumeQty = Math.abs(difference);
          const fifo = await this.stockFifo.consumeLots(tx, item.productId, consumeQty, {
            requireFullCoverage: true,
          });

          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: StockMovementType.INVENTORY_ADJUSTMENT,
              quantity: -consumeQty,
              balanceAfter: nextOnHand,
              sourceType: 'INVENTORY',
              sourceId: id,
              comment,
              createdByUserId: actor.id,
              allocations: {
                create: fifo.allocations.map((a) => ({
                  stockLotId: a.stockLotId,
                  quantity: a.quantity,
                  unitPurchasePrice: a.unitPurchasePrice,
                })),
              },
            },
          });
        } else {
          // Positive surplus: uncosted inventory lot (unitPurchasePrice = null intentionally).
          surplusProductIds.push(item.productId);
          await tx.stockLot.create({
            data: {
              productId: item.productId,
              sourceType: StockLotSource.INVENTORY,
              inventoryItemId: item.id,
              supplyItemId: null,
              receivedQuantity: difference,
              remainingQuantity: difference,
              unitPurchasePrice: null,
              receivedAt: completedAt,
            },
          });

          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: StockMovementType.INVENTORY_ADJUSTMENT,
              quantity: difference,
              balanceAfter: nextOnHand,
              sourceType: 'INVENTORY',
              sourceId: id,
              comment,
              createdByUserId: actor.id,
            },
          });
        }
      }

      await tx.inventorySession.update({
        where: { id },
        data: {
          status: InventoryStatus.COMPLETED,
          completedAt,
          completedByUserId: actor.id,
        },
      });

      if (surplusProductIds.length > 0) {
        await this.reservationAllocation.allocateAvailableForProducts(
          tx,
          surplusProductIds,
          context,
          actor.id,
        );
      }

      await this.audit.log({
        action: AuditAction.INVENTORY_COMPLETED,
        actorUserId: actor.id,
        entityType: 'InventorySession',
        entityId: id,
        metadata: {
          inventoryId: id,
          inventoryNumber: session.number,
          numberLabel: formatInventoryNumber(session.number),
          itemCount: items.length,
          differenceItemCount,
          positiveQuantity,
          negativeQuantity,
        },
        context,
        tx,
      });

      return tx.inventorySession.findUniqueOrThrow({
        where: { id },
        include: sessionDetailInclude,
      });
    });

    return toInventoryDetail(completed);
  }

  async cancel(
    actor: AuthenticatedUser,
    id: string,
    dto: CancelInventoryDto,
    context: RequestContext,
  ): Promise<InventoryDetail> {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      await this.warehouseLock.acquireWarehouseLock(tx);

      const session = await this.lockSession(tx, id);
      if (session.status === InventoryStatus.COMPLETED) {
        throw new AppError(
          'INVENTORY_ALREADY_COMPLETED',
          'Завершённую инвентаризацию нельзя отменить',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (session.status === InventoryStatus.CANCELLED) {
        throw new AppError(
          'INVENTORY_NOT_EDITABLE',
          'Инвентаризация уже отменена',
          {},
          HttpStatus.CONFLICT,
        );
      }

      if (session.status === InventoryStatus.IN_PROGRESS) {
        const reason = dto.reason?.trim();
        if (!reason || reason.length < 3) {
          throw new AppError(
            'INVENTORY_CANCEL_REASON_REQUIRED',
            'Укажите причину отмены инвентаризации',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      await tx.inventorySession.update({
        where: { id },
        data: {
          status: InventoryStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      await this.audit.log({
        action: AuditAction.INVENTORY_CANCELLED,
        actorUserId: actor.id,
        entityType: 'InventorySession',
        entityId: id,
        metadata: {
          inventoryId: id,
          inventoryNumber: session.number,
          numberLabel: formatInventoryNumber(session.number),
          reason: dto.reason ?? null,
          previousStatus: session.status,
        },
        context,
        tx,
      });

      return tx.inventorySession.findUniqueOrThrow({
        where: { id },
        include: sessionDetailInclude,
      });
    });

    return toInventoryDetail(cancelled);
  }

  private assertInProgress(session: { status: InventoryStatus }): void {
    if (session.status !== InventoryStatus.IN_PROGRESS) {
      throw new AppError(
        'INVENTORY_NOT_EDITABLE',
        'Ввод факта доступен только во время инвентаризации',
        { status: session.status },
        HttpStatus.CONFLICT,
      );
    }
  }

  private async assertNoOpenInventory(tx: Tx): Promise<void> {
    const open = await tx.inventorySession.findFirst({
      where: { status: { in: [InventoryStatus.DRAFT, InventoryStatus.IN_PROGRESS] } },
      select: { id: true, number: true, status: true },
    });
    if (open) {
      throw new AppError(
        'INVENTORY_IN_PROGRESS',
        open.status === InventoryStatus.DRAFT
          ? `Уже есть черновик инвентаризации ${formatInventoryNumber(open.number)}`
          : `Уже идёт инвентаризация ${formatInventoryNumber(open.number)}`,
        {
          inventoryId: open.id,
          inventoryNumber: open.number,
          numberLabel: formatInventoryNumber(open.number),
          status: open.status,
        },
        HttpStatus.CONFLICT,
      );
    }
  }

  private async lockSession(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        number: number;
        status: InventoryStatus;
        comment: string | null;
      }>
    >`
      SELECT id, number, status, comment
      FROM inventory_sessions
      WHERE id = ${id}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new AppError(
        'INVENTORY_NOT_FOUND',
        'Инвентаризация не найдена',
        {},
        HttpStatus.NOT_FOUND,
      );
    }
    return rows[0]!;
  }

  private async nextInventoryNumber(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ nextval: bigint | number }>>`
      SELECT nextval('inventory_number_seq') AS nextval
    `;
    return Number(rows[0]!.nextval);
  }
}
