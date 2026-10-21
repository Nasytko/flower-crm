import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssembledBouquetStatus,
  AuditAction,
  OrderItemType,
  OrderStatus,
  Permission,
  ProductType,
  Role,
  StockMovementType,
  roleHasPermission,
  type AssembledBouquetDetail,
  type AssembledBouquetListItem,
  type MoneyString,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { WarehouseLockService } from './warehouse-lock.service';
import { StockFifoService } from './stock-fifo.service';
import { StockBalanceService } from './stock-balance.service';
import { ReservationAllocationService } from './reservation-allocation.service';
import { AppConfigService } from '../../config/app-config.service';
import {
  businessDateString,
  parseIsoDateOnly,
  toOrderNumberDatePrefix,
} from '../orders/business-time';

type Tx = Prisma.TransactionClient;

export type AssembleComponentInput = {
  productId: string;
  quantity: number;
};

export type AssembleInput = {
  orderId?: string | null;
  orderItemId?: string | null;
  bouquetTemplateId?: string | null;
  nameSnapshot: string;
  components: AssembleComponentInput[];
  idempotencyKey?: string;
  /** Allow consuming stock reserved for higher-priority orders. */
  allowReserveOverride?: boolean;
  expectedOrderVersion?: number;
};

export type DisassembleLineInput = {
  productId: string;
  returnQuantity: number;
  damageQuantity: number;
};

export type DisassembleInput = {
  expectedVersion: number;
  reason: string;
  lines: DisassembleLineInput[];
};

export type AdjustComponentInput = {
  productId: string;
  /** Absolute target quantity in the bouquet after adjust (>= 0; 0 removes). */
  quantity: number;
  /** Of any reduction, how many are damaged (rest returned fit). */
  damageQuantity?: number;
};

export type AdjustInput = {
  expectedVersion: number;
  components: AdjustComponentInput[];
  allowReserveOverride?: boolean;
  reason?: string;
};

@Injectable()
export class AssembledBouquetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly warehouseLock: WarehouseLockService,
    private readonly stockFifo: StockFifoService,
    private readonly stockBalance: StockBalanceService,
    private readonly reservations: ReservationAllocationService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async getById(id: string, actor: AuthenticatedUser): Promise<AssembledBouquetDetail> {
    const row = await this.prisma.assembledBouquet.findUnique({
      where: { id },
      include: this.detailInclude,
    });
    if (!row) {
      throw new AppError('ASSEMBLED_BOUQUET_NOT_FOUND', 'Букет не найден', {}, HttpStatus.NOT_FOUND);
    }
    return this.toDetail(row, actor);
  }

  async listDisplay(actor: AuthenticatedUser): Promise<AssembledBouquetListItem[]> {
    const rows = await this.prisma.assembledBouquet.findMany({
      where: { status: AssembledBouquetStatus.ASSEMBLED, orderId: null },
      include: {
        assembledBy: { select: { name: true } },
        order: { select: { number: true } },
      },
      orderBy: { assembledAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toListItem(r, actor));
  }

  async listContainingProduct(
    productId: string,
    actor: AuthenticatedUser,
  ): Promise<AssembledBouquetListItem[]> {
    const rows = await this.prisma.assembledBouquet.findMany({
      where: {
        status: AssembledBouquetStatus.ASSEMBLED,
        components: { some: { productId } },
      },
      include: {
        assembledBy: { select: { name: true } },
        order: { select: { number: true } },
      },
      orderBy: { assembledAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toListItem(r, actor));
  }

  async assemble(
    actor: AuthenticatedUser,
    input: AssembleInput,
    context: RequestContext,
  ): Promise<AssembledBouquetDetail> {
    this.requirePermission(actor, Permission.ORDERS_ASSEMBLE);

    if (!input.components?.length) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Укажите состав букета',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    for (const c of input.components) {
      if (!c.productId || c.quantity <= 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Количество компонента должно быть больше нуля',
          { productId: c.productId },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    if (input.idempotencyKey) {
      const existing = await this.prisma.assembledBouquet.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: this.detailInclude,
      });
      if (existing) return this.toDetail(existing, actor);
    }

    const created = await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);

        if (input.idempotencyKey) {
          const again = await tx.assembledBouquet.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: this.detailInclude,
          });
          if (again) return again;
        }

        let order: {
          id: string;
          number: string;
          status: OrderStatus;
          version: number;
          fulfillmentDate: Date;
        } | null = null;

        if (input.orderId) {
          const orderRow = await tx.order.findUnique({
            where: { id: input.orderId },
            select: {
              id: true,
              number: true,
              status: true,
              version: true,
              fulfillmentDate: true,
            },
          });
          if (!orderRow) {
            throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
          }
          order = {
            ...orderRow,
            status: orderRow.status as OrderStatus,
          };
          if (
            order.status === OrderStatus.COMPLETED ||
            order.status === OrderStatus.CANCELLED
          ) {
            throw new AppError(
              'ORDER_NOT_EDITABLE',
              'Нельзя собирать букет для завершённого или отменённого заказа',
              { status: order.status },
              HttpStatus.CONFLICT,
            );
          }
          if (
            input.expectedOrderVersion != null &&
            order.version !== input.expectedOrderVersion
          ) {
            throw new AppError(
              'ORDER_CONFLICT',
              'Заказ был изменён. Обновите страницу.',
              {
                expectedVersion: input.expectedOrderVersion,
                currentVersion: order.version,
              },
              HttpStatus.CONFLICT,
            );
          }
          if (input.orderItemId) {
            const item = await tx.orderItem.findFirst({
              where: { id: input.orderItemId, orderId: order.id },
            });
            if (!item) {
              throw new AppError(
                'ORDER_ITEM_NOT_FOUND',
                'Позиция заказа не найдена',
                {},
                HttpStatus.NOT_FOUND,
              );
            }
            const assembledCount = await tx.assembledBouquet.count({
              where: {
                orderItemId: item.id,
                status: {
                  in: [AssembledBouquetStatus.ASSEMBLED, AssembledBouquetStatus.ISSUED],
                },
              },
            });
            if (assembledCount >= item.quantity) {
              throw new AppError(
                'ORDER_ITEM_FULLY_ASSEMBLED',
                'Все единицы этой позиции уже собраны',
                { orderItemId: item.id, quantity: item.quantity, assembledCount },
                HttpStatus.CONFLICT,
              );
            }
          }
        }

        const productIds = [...new Set(input.components.map((c) => c.productId))].sort();
        await this.reservations.lockProductStocks(tx, productIds);

        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, type: true },
        });
        const productById = new Map(products.map((p) => [p.id, p]));

        for (const c of input.components) {
          const p = productById.get(c.productId);
          if (!p || p.type !== ProductType.FLOWER) {
            throw new AppError(
              'VALIDATION_ERROR',
              'В состав букета можно включать только цветы',
              { productId: c.productId },
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        // Reserve-override check: qty beyond this order's planned reserve needs free available
        // or explicit override (cannot silently take higher-priority reserve).
        for (const c of input.components) {
          const stock = await tx.productStock.findUniqueOrThrow({
            where: { productId: c.productId },
          });
          const available = stock.quantityOnHand - stock.quantityReserved;
          const ownReserve = order
            ? await this.reservations.reservedForOrder(tx, order.id, c.productId)
            : 0;
          const covered = available + ownReserve;
          if (c.quantity > covered) {
            if (!input.allowReserveOverride) {
              throw new AppError(
                'RESERVE_OVERRIDE_REQUIRED',
                'Нельзя взять цветы, зарезервированные под более срочные заказы. Подтвердите исключение или расформируйте другой букет.',
                {
                  productId: c.productId,
                  productName: productById.get(c.productId)?.name,
                  requested: c.quantity,
                  available,
                  ownReserve,
                },
                HttpStatus.CONFLICT,
              );
            }
            if (!roleHasPermission(actor.role as Role, Permission.ORDERS_RESERVE_OVERRIDE)) {
              throw new AppError(
                'FORBIDDEN',
                'Недостаточно прав для использования чужого резерва',
                {},
                HttpStatus.FORBIDDEN,
              );
            }
            await this.audit.log({
              action: AuditAction.RESERVE_OVERRIDE_USED,
              actorUserId: actor.id,
              entityType: 'Order',
              entityId: order?.id ?? null,
              metadata: {
                productId: c.productId,
                requested: c.quantity,
                available,
                ownReserve,
              },
              context,
              tx,
            });
          }
          if (c.quantity > stock.quantityOnHand) {
            throw new AppError(
              'INSUFFICIENT_STOCK',
              'Недостаточно цветов на полке для сборки',
              {
                productId: c.productId,
                requested: c.quantity,
                quantityOnHand: stock.quantityOnHand,
              },
              HttpStatus.CONFLICT,
            );
          }
        }

        const now = new Date();
        const businessDate = businessDateString(now, this.config.businessTimeZone);
        const number = await this.nextBouquetNumber(tx, businessDate);

        let knownCost = new Prisma.Decimal(0);
        let hasUncosted = false;
        const componentCreates: Array<{
          productId: string;
          productNameSnapshot: string;
          quantity: number;
          sortOrder: number;
          lots: Array<{
            stockLotId: string;
            quantity: number;
            remainingQuantity: number;
            unitPurchasePrice: Prisma.Decimal | null;
          }>;
        }> = [];

        let sortOrder = 0;
        for (const c of input.components) {
          const fifo = await this.stockFifo.consumeLots(tx, c.productId, c.quantity, {
            requireFullCoverage: true,
            mode: 'FEFO',
            requiredUsableUntil: order?.fulfillmentDate ?? null,
          });
          if (fifo.hasUncosted) hasUncosted = true;
          else knownCost = knownCost.plus(fifo.knownCost);

          const stock = await tx.productStock.findUniqueOrThrow({
            where: { productId: c.productId },
          });
          const nextOnHand = stock.quantityOnHand - c.quantity;
          const nextInBouquets = stock.quantityInBouquets + c.quantity;
          // Temporarily allow reserved > onHand until reallocate; clamp reserved after.
          if (nextOnHand < 0) {
            throw new AppError(
              'INSUFFICIENT_STOCK',
              'Недостаточно цветов на полке для сборки',
              { productId: c.productId },
              HttpStatus.CONFLICT,
            );
          }
          await tx.productStock.update({
            where: { productId: c.productId },
            data: {
              quantityOnHand: nextOnHand,
              quantityInBouquets: nextInBouquets,
              // reserved may exceed onHand briefly; reallocateProducts fixes it
              quantityReserved: Math.min(stock.quantityReserved, nextOnHand),
            },
          });

          await tx.stockMovement.create({
            data: {
              productId: c.productId,
              type: StockMovementType.ASSEMBLE,
              quantity: -c.quantity,
              balanceAfter: nextOnHand,
              sourceType: 'AssembledBouquet',
              sourceId: null, // filled after create via update — use number as comment
              comment: `Сборка ${number}`,
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

          componentCreates.push({
            productId: c.productId,
            productNameSnapshot: productById.get(c.productId)?.name ?? c.productId,
            quantity: c.quantity,
            sortOrder: sortOrder++,
            lots: fifo.allocations.map((a) => ({
              stockLotId: a.stockLotId,
              quantity: a.quantity,
              remainingQuantity: a.quantity,
              unitPurchasePrice: a.unitPurchasePrice,
            })),
          });
        }

        const bouquet = await tx.assembledBouquet.create({
          data: {
            number,
            status: AssembledBouquetStatus.ASSEMBLED,
            orderId: order?.id ?? null,
            orderItemId: input.orderItemId ?? null,
            bouquetTemplateId: input.bouquetTemplateId ?? null,
            nameSnapshot: input.nameSnapshot.trim() || 'Букет',
            idempotencyKey: input.idempotencyKey ?? null,
            unitCost: hasUncosted ? null : knownCost.toDecimalPlaces(2),
            hasUncostedComponents: hasUncosted,
            assembledByUserId: actor.id,
            components: {
              create: componentCreates.map((c) => ({
                productId: c.productId,
                productNameSnapshot: c.productNameSnapshot,
                quantity: c.quantity,
                sortOrder: c.sortOrder,
                lots: {
                  create: c.lots.map((l) => ({
                    stockLotId: l.stockLotId,
                    quantity: l.quantity,
                    remainingQuantity: l.remainingQuantity,
                    unitPurchasePrice: l.unitPurchasePrice,
                  })),
                },
              })),
            },
          },
          include: this.detailInclude,
        });

        await tx.stockMovement.updateMany({
          where: {
            sourceType: 'AssembledBouquet',
            sourceId: null,
            comment: `Сборка ${number}`,
          },
          data: { sourceId: bouquet.id },
        });

        await this.reservations.reallocateProducts(tx, productIds, context, actor.id);

        if (order) {
          await this.syncOrderStatusAfterAssembly(tx, order.id, actor.id);
        }

        await this.audit.log({
          action: AuditAction.BOUQUET_ASSEMBLED,
          actorUserId: actor.id,
          entityType: 'AssembledBouquet',
          entityId: bouquet.id,
          after: { number: bouquet.number, orderId: bouquet.orderId, status: bouquet.status },
          metadata: {
            componentCount: input.components.length,
            allowReserveOverride: Boolean(input.allowReserveOverride),
          },
          context,
          tx,
        });

        return bouquet;
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    return this.toDetail(created, actor);
  }

  async disassemble(
    actor: AuthenticatedUser,
    id: string,
    input: DisassembleInput,
    context: RequestContext,
  ): Promise<AssembledBouquetDetail> {
    this.requirePermission(actor, Permission.ORDERS_ASSEMBLE);
    if (!input.reason?.trim()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Укажите причину расформирования',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);
        const bouquet = await tx.assembledBouquet.findUnique({
          where: { id },
          include: {
            components: { include: { lots: true } },
            order: { select: { id: true, status: true } },
          },
        });
        if (!bouquet) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_FOUND',
            'Букет не найден',
            {},
            HttpStatus.NOT_FOUND,
          );
        }
        if (bouquet.status !== AssembledBouquetStatus.ASSEMBLED) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_DISASSEMBLABLE',
            'Можно расформировать только собранный букет, который ещё в магазине',
            { status: bouquet.status },
            HttpStatus.CONFLICT,
          );
        }
        if (bouquet.version !== input.expectedVersion) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            { expectedVersion: input.expectedVersion, currentVersion: bouquet.version },
            HttpStatus.CONFLICT,
          );
        }

        const lineByProduct = new Map(input.lines.map((l) => [l.productId, l]));
        const productIds = bouquet.components.map((c) => c.productId).sort();
        await this.reservations.lockProductStocks(tx, productIds);

        for (const comp of bouquet.components) {
          const line = lineByProduct.get(comp.productId) ?? {
            productId: comp.productId,
            returnQuantity: comp.quantity,
            damageQuantity: 0,
          };
          if (line.returnQuantity < 0 || line.damageQuantity < 0) {
            throw new AppError(
              'VALIDATION_ERROR',
              'Количество не может быть отрицательным',
              { productId: comp.productId },
              HttpStatus.BAD_REQUEST,
            );
          }
          if (line.returnQuantity + line.damageQuantity !== comp.quantity) {
            throw new AppError(
              'VALIDATION_ERROR',
              'Сумма пригодных и повреждённых должна равняться составу букета',
              {
                productId: comp.productId,
                inBouquet: comp.quantity,
                returnQuantity: line.returnQuantity,
                damageQuantity: line.damageQuantity,
              },
              HttpStatus.BAD_REQUEST,
            );
          }

          await this.releaseComponentFromBouquet(tx, {
            bouquetId: bouquet.id,
            bouquetNumber: bouquet.number,
            component: comp,
            returnQuantity: line.returnQuantity,
            damageQuantity: line.damageQuantity,
            actorUserId: actor.id,
          });
        }

        const cas = await tx.assembledBouquet.updateMany({
          where: { id, version: input.expectedVersion, status: AssembledBouquetStatus.ASSEMBLED },
          data: {
            status: AssembledBouquetStatus.DISASSEMBLED,
            version: { increment: 1 },
            disassembledAt: new Date(),
            disassembledByUserId: actor.id,
            disassembleReason: input.reason.trim(),
          },
        });
        if (cas.count === 0) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }

        await this.reservations.reallocateProducts(tx, productIds, context, actor.id);

        if (bouquet.orderId) {
          // Order is NOT cancelled — open needs return to planned reserve via reallocate.
          await this.syncOrderStatusAfterAssembly(tx, bouquet.orderId, actor.id);
        }

        await this.audit.log({
          action: AuditAction.BOUQUET_DISASSEMBLED,
          actorUserId: actor.id,
          entityType: 'AssembledBouquet',
          entityId: id,
          metadata: { reason: input.reason.trim(), orderId: bouquet.orderId },
          context,
          tx,
        });

        return tx.assembledBouquet.findUniqueOrThrow({
          where: { id },
          include: this.detailInclude,
        });
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    return this.toDetail(updated, actor);
  }

  async adjust(
    actor: AuthenticatedUser,
    id: string,
    input: AdjustInput,
    context: RequestContext,
  ): Promise<AssembledBouquetDetail> {
    this.requirePermission(actor, Permission.ORDERS_ASSEMBLE);

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);
        const bouquet = await tx.assembledBouquet.findUnique({
          where: { id },
          include: {
            components: { include: { lots: true } },
            order: { select: { id: true, fulfillmentDate: true } },
          },
        });
        if (!bouquet) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_FOUND',
            'Букет не найден',
            {},
            HttpStatus.NOT_FOUND,
          );
        }
        if (bouquet.status !== AssembledBouquetStatus.ASSEMBLED) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_ADJUSTABLE',
            'Можно менять состав только собранного букета в магазине',
            { status: bouquet.status },
            HttpStatus.CONFLICT,
          );
        }
        if (bouquet.version !== input.expectedVersion) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }

        const touched = new Set<string>();
        const existingByProduct = new Map(bouquet.components.map((c) => [c.productId, c]));

        for (const adj of input.components) {
          if (adj.quantity < 0 || (adj.damageQuantity ?? 0) < 0) {
            throw new AppError(
              'VALIDATION_ERROR',
              'Количество не может быть отрицательным',
              {},
              HttpStatus.BAD_REQUEST,
            );
          }
          touched.add(adj.productId);
          const cur = existingByProduct.get(adj.productId);
          const currentQty = cur?.quantity ?? 0;
          const target = adj.quantity;
          const damage = adj.damageQuantity ?? 0;

          if (target === currentQty && damage === 0) continue;

          if (target < currentQty) {
            const remove = currentQty - target;
            if (damage > remove) {
              throw new AppError(
                'VALIDATION_ERROR',
                'Повреждённых не может быть больше удаляемых',
                { productId: adj.productId },
                HttpStatus.BAD_REQUEST,
              );
            }
            if (!cur) continue;
            await this.releaseComponentFromBouquet(tx, {
              bouquetId: bouquet.id,
              bouquetNumber: bouquet.number,
              component: cur,
              returnQuantity: remove - damage,
              damageQuantity: damage,
              actorUserId: actor.id,
              keepComponent: target > 0,
              remainingAfter: target,
            });
          } else if (target > currentQty) {
            const add = target - currentQty;
            await this.addToBouquet(tx, {
              bouquet,
              productId: adj.productId,
              quantity: add,
              actor,
              context,
              allowReserveOverride: Boolean(input.allowReserveOverride),
            });
          }
        }

        let knownCost = new Prisma.Decimal(0);
        let hasUncosted = false;
        const comps = await tx.assembledBouquetComponent.findMany({
          where: { assembledBouquetId: id },
          include: { lots: true },
        });
        for (const c of comps) {
          for (const l of c.lots) {
            if (l.remainingQuantity <= 0) continue;
            if (l.unitPurchasePrice == null) hasUncosted = true;
            else knownCost = knownCost.plus(l.unitPurchasePrice.mul(l.remainingQuantity));
          }
        }

        const cas = await tx.assembledBouquet.updateMany({
          where: { id, version: input.expectedVersion, status: AssembledBouquetStatus.ASSEMBLED },
          data: {
            version: { increment: 1 },
            lastAdjustedAt: new Date(),
            lastAdjustedByUserId: actor.id,
            unitCost: hasUncosted ? null : knownCost.toDecimalPlaces(2),
            hasUncostedComponents: hasUncosted,
          },
        });
        if (cas.count === 0) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }

        await this.reservations.reallocateProducts(tx, [...touched], context, actor.id);
        if (bouquet.orderId) {
          await this.syncOrderStatusAfterAssembly(tx, bouquet.orderId, actor.id);
        }

        await this.audit.log({
          action: AuditAction.BOUQUET_ADJUSTED,
          actorUserId: actor.id,
          entityType: 'AssembledBouquet',
          entityId: id,
          metadata: { reason: input.reason ?? null },
          context,
          tx,
        });

        return tx.assembledBouquet.findUniqueOrThrow({
          where: { id },
          include: this.detailInclude,
        });
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    return this.toDetail(updated, actor);
  }

  async issue(
    actor: AuthenticatedUser,
    id: string,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<AssembledBouquetDetail> {
    this.requirePermission(actor, Permission.ORDERS_ISSUE);

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);
        const bouquet = await tx.assembledBouquet.findUnique({
          where: { id },
          include: { components: { include: { lots: true } } },
        });
        if (!bouquet) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_FOUND',
            'Букет не найден',
            {},
            HttpStatus.NOT_FOUND,
          );
        }
        if (bouquet.status !== AssembledBouquetStatus.ASSEMBLED) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_ISSUABLE',
            'Выдать можно только собранный букет',
            { status: bouquet.status },
            HttpStatus.CONFLICT,
          );
        }
        if (bouquet.version !== expectedVersion) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }

        const productIds = bouquet.components.map((c) => c.productId).sort();
        await this.reservations.lockProductStocks(tx, productIds);

        for (const comp of bouquet.components) {
          await this.stockBalance.adjustInBouquets(tx, comp.productId, -comp.quantity);
          const stock = await tx.productStock.findUniqueOrThrow({
            where: { productId: comp.productId },
          });
          await tx.stockMovement.create({
            data: {
              productId: comp.productId,
              type: StockMovementType.ISSUE,
              quantity: -comp.quantity,
              balanceAfter: stock.quantityOnHand,
              sourceType: 'AssembledBouquet',
              sourceId: bouquet.id,
              comment: `Выдача ${bouquet.number}`,
              createdByUserId: actor.id,
              allocations: {
                create: comp.lots
                  .filter((l) => l.remainingQuantity > 0)
                  .map((l) => ({
                    stockLotId: l.stockLotId,
                    quantity: l.remainingQuantity,
                    unitPurchasePrice: l.unitPurchasePrice,
                  })),
              },
            },
          });
          for (const lot of comp.lots) {
            if (lot.remainingQuantity > 0) {
              await tx.assembledBouquetComponentLot.update({
                where: { id: lot.id },
                data: { remainingQuantity: 0 },
              });
            }
          }
        }

        const cas = await tx.assembledBouquet.updateMany({
          where: { id, version: expectedVersion, status: AssembledBouquetStatus.ASSEMBLED },
          data: {
            status: AssembledBouquetStatus.ISSUED,
            version: { increment: 1 },
            issuedAt: new Date(),
            issuedByUserId: actor.id,
          },
        });
        if (cas.count === 0) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }

        if (bouquet.orderItemId) {
          await tx.orderItem.update({
            where: { id: bouquet.orderItemId },
            data: { quantityIssued: { increment: 1 } },
          });
        }
        if (bouquet.orderId) {
          await this.syncOrderStatusAfterIssue(tx, bouquet.orderId, actor.id);
        }

        await this.audit.log({
          action: AuditAction.BOUQUET_ISSUED,
          actorUserId: actor.id,
          entityType: 'AssembledBouquet',
          entityId: id,
          metadata: { orderId: bouquet.orderId },
          context,
          tx,
        });

        return tx.assembledBouquet.findUniqueOrThrow({
          where: { id },
          include: this.detailInclude,
        });
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    return this.toDetail(updated, actor);
  }

  /** Direct issue of PRODUCT line flowers without AssembledBouquet. */
  async directIssueOrderItem(
    actor: AuthenticatedUser,
    orderId: string,
    orderItemId: string,
    quantity: number,
    expectedOrderVersion: number,
    context: RequestContext,
  ): Promise<void> {
    this.requirePermission(actor, Permission.ORDERS_ISSUE);
    if (quantity <= 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Количество выдачи должно быть больше нуля',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) {
          throw new AppError('ORDER_NOT_FOUND', 'Заказ не найден', {}, HttpStatus.NOT_FOUND);
        }
        if (order.version !== expectedOrderVersion) {
          throw new AppError(
            'ORDER_CONFLICT',
            'Заказ был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }
        if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) {
          throw new AppError(
            'ORDER_NOT_EDITABLE',
            'Нельзя выдать позицию завершённого или отменённого заказа',
            {},
            HttpStatus.CONFLICT,
          );
        }

        const item = await tx.orderItem.findFirst({
          where: { id: orderItemId, orderId },
          include: { product: true },
        });
        if (!item || item.itemType !== OrderItemType.PRODUCT || !item.productId) {
          throw new AppError(
            'ORDER_ITEM_NOT_FOUND',
            'Прямая выдача доступна только для товарных позиций',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        if (item.product?.type !== ProductType.FLOWER) {
          // SERVICE: just mark issued
          if (item.quantityIssued + quantity > item.quantity) {
            throw new AppError(
              'VALIDATION_ERROR',
              'Нельзя выдать больше, чем в заказе',
              {},
              HttpStatus.BAD_REQUEST,
            );
          }
          await tx.orderItem.update({
            where: { id: item.id },
            data: { quantityIssued: { increment: quantity } },
          });
          await this.syncOrderStatusAfterIssue(tx, orderId, actor.id);
          return;
        }

        if (item.quantityIssued + quantity > item.quantity) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Нельзя выдать больше, чем в заказе',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }

        await this.reservations.lockProductStocks(tx, [item.productId]);
        const stock = await tx.productStock.findUniqueOrThrow({
          where: { productId: item.productId },
        });
        const ownReserve = await this.reservations.reservedForOrder(tx, orderId, item.productId);
        const available = stock.quantityOnHand - stock.quantityReserved;
        if (quantity > available + ownReserve) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            'Недостаточно цветов для прямой выдачи',
            {
              available,
              ownReserve,
              requested: quantity,
            },
            HttpStatus.CONFLICT,
          );
        }

        const fifo = await this.stockFifo.consumeLots(tx, item.productId, quantity, {
          requireFullCoverage: true,
          mode: 'FEFO',
          requiredUsableUntil: order.fulfillmentDate,
        });

        const nextOnHand = stock.quantityOnHand - quantity;
        await tx.productStock.update({
          where: { productId: item.productId },
          data: {
            quantityOnHand: nextOnHand,
            quantityReserved: Math.min(stock.quantityReserved, nextOnHand),
          },
        });

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: StockMovementType.DIRECT_ISSUE,
            quantity: -quantity,
            balanceAfter: nextOnHand,
            sourceType: 'Order',
            sourceId: orderId,
            comment: `Прямая выдача ${order.number}`,
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

        await tx.orderItem.update({
          where: { id: item.id },
          data: { quantityIssued: { increment: quantity } },
        });

        // Fold COGS into order.actualCost when fully known
        if (!fifo.hasUncosted) {
          const prev = order.actualCost ?? new Prisma.Decimal(0);
          await tx.order.update({
            where: { id: orderId },
            data: {
              actualCost: prev.plus(fifo.knownCost).toDecimalPlaces(2),
              version: { increment: 1 },
            },
          });
        } else {
          await tx.order.update({
            where: { id: orderId },
            data: {
              hasUncostedConsumption: true,
              actualCost: null,
              version: { increment: 1 },
            },
          });
        }

        await this.reservations.reallocateProducts(tx, [item.productId], context, actor.id);
        await this.syncOrderStatusAfterIssue(tx, orderId, actor.id);

        await this.audit.log({
          action: AuditAction.ORDER_DIRECT_ISSUED,
          actorUserId: actor.id,
          entityType: 'Order',
          entityId: orderId,
          metadata: { orderItemId, quantity, productId: item.productId },
          context,
          tx,
        });
      },
      { maxWait: 20_000, timeout: 60_000 },
    );
  }

  async writeOffAssembled(
    actor: AuthenticatedUser,
    id: string,
    expectedVersion: number,
    reason: string,
    context: RequestContext,
  ): Promise<AssembledBouquetDetail> {
    this.requirePermission(actor, Permission.ORDERS_ASSEMBLE);
    if (!reason?.trim()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Укажите причину списания',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await this.warehouseLock.beginStockMutation(tx);
        const bouquet = await tx.assembledBouquet.findUnique({
          where: { id },
          include: { components: { include: { lots: true } } },
        });
        if (!bouquet) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_FOUND',
            'Букет не найден',
            {},
            HttpStatus.NOT_FOUND,
          );
        }
        if (bouquet.status !== AssembledBouquetStatus.ASSEMBLED) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_NOT_WRITABLE',
            'Списать можно только собранный букет в магазине',
            { status: bouquet.status },
            HttpStatus.CONFLICT,
          );
        }
        if (bouquet.version !== expectedVersion) {
          throw new AppError(
            'ASSEMBLED_BOUQUET_CONFLICT',
            'Букет был изменён. Обновите страницу.',
            {},
            HttpStatus.CONFLICT,
          );
        }

        const productIds = bouquet.components.map((c) => c.productId).sort();
        await this.reservations.lockProductStocks(tx, productIds);

        for (const comp of bouquet.components) {
          await this.releaseComponentFromBouquet(tx, {
            bouquetId: bouquet.id,
            bouquetNumber: bouquet.number,
            component: comp,
            returnQuantity: 0,
            damageQuantity: comp.quantity,
            actorUserId: actor.id,
          });
        }

        await tx.assembledBouquet.update({
          where: { id },
          data: {
            status: AssembledBouquetStatus.WRITTEN_OFF,
            version: { increment: 1 },
            writtenOffAt: new Date(),
            writtenOffByUserId: actor.id,
            writeOffReason: reason.trim(),
          },
        });

        // Detach from order needs: treat as gone; sync order status.
        if (bouquet.orderId) {
          // Keep link for history; open requirements ignore WRITTEN_OFF.
          await this.reservations.reallocateProducts(tx, productIds, context, actor.id);
          await this.syncOrderStatusAfterAssembly(tx, bouquet.orderId, actor.id);
        } else {
          await this.reservations.reallocateProducts(tx, productIds, context, actor.id);
        }

        await this.audit.log({
          action: AuditAction.BOUQUET_WRITTEN_OFF,
          actorUserId: actor.id,
          entityType: 'AssembledBouquet',
          entityId: id,
          metadata: { reason: reason.trim() },
          context,
          tx,
        });

        return tx.assembledBouquet.findUniqueOrThrow({
          where: { id },
          include: this.detailInclude,
        });
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    return this.toDetail(updated, actor);
  }

  async linkToOrder(
    actor: AuthenticatedUser,
    id: string,
    orderId: string,
    orderItemId: string | null,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<AssembledBouquetDetail> {
    this.requirePermission(actor, Permission.ORDERS_ASSEMBLE);

    const updated = await this.prisma.$transaction(async (tx) => {
      const bouquet = await tx.assembledBouquet.findUnique({ where: { id } });
      if (!bouquet || bouquet.status !== AssembledBouquetStatus.ASSEMBLED) {
        throw new AppError(
          'ASSEMBLED_BOUQUET_NOT_FOUND',
          'Можно привязать только собранный букет',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (bouquet.orderId) {
        throw new AppError(
          'ASSEMBLED_BOUQUET_ALREADY_LINKED',
          'Букет уже привязан к заказу',
          {},
          HttpStatus.CONFLICT,
        );
      }
      if (bouquet.version !== expectedVersion) {
        throw new AppError(
          'ASSEMBLED_BOUQUET_CONFLICT',
          'Букет был изменён. Обновите страницу.',
          {},
          HttpStatus.CONFLICT,
        );
      }
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) {
        throw new AppError('ORDER_NOT_EDITABLE', 'Заказ недоступен для привязки', {}, HttpStatus.CONFLICT);
      }

      await tx.assembledBouquet.update({
        where: { id },
        data: {
          orderId,
          orderItemId,
          version: { increment: 1 },
        },
      });

      await this.reservations.reconcileOrderReservations(tx, orderId);
      await this.syncOrderStatusAfterAssembly(tx, orderId, actor.id);

      await this.audit.log({
        action: AuditAction.BOUQUET_LINKED_TO_ORDER,
        actorUserId: actor.id,
        entityType: 'AssembledBouquet',
        entityId: id,
        metadata: { orderId, orderItemId },
        context,
        tx,
      });

      return tx.assembledBouquet.findUniqueOrThrow({
        where: { id },
        include: this.detailInclude,
      });
    });

    return this.toDetail(updated, actor);
  }

  // --- internals ---

  private async addToBouquet(
    tx: Tx,
    args: {
      bouquet: {
        id: string;
        number: string;
        orderId: string | null;
        order?: { fulfillmentDate: Date } | null;
      };
      productId: string;
      quantity: number;
      actor: AuthenticatedUser;
      context: RequestContext;
      allowReserveOverride: boolean;
    },
  ): Promise<void> {
    const { bouquet, productId, quantity, actor, context, allowReserveOverride } = args;
    await this.reservations.lockProductStocks(tx, [productId]);
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    if (product.type !== ProductType.FLOWER) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Добавлять можно только цветы',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    const stock = await tx.productStock.findUniqueOrThrow({ where: { productId } });
    const available = stock.quantityOnHand - stock.quantityReserved;
    const ownReserve = bouquet.orderId
      ? await this.reservations.reservedForOrder(tx, bouquet.orderId, productId)
      : 0;
    if (quantity > available + ownReserve) {
      if (!allowReserveOverride) {
        throw new AppError(
          'RESERVE_OVERRIDE_REQUIRED',
          'Нельзя взять цветы из резерва более срочных заказов без подтверждения',
          { productId, available, ownReserve, requested: quantity },
          HttpStatus.CONFLICT,
        );
      }
      if (!roleHasPermission(actor.role as Role, Permission.ORDERS_RESERVE_OVERRIDE)) {
        throw new AppError('FORBIDDEN', 'Недостаточно прав', {}, HttpStatus.FORBIDDEN);
      }
      await this.audit.log({
        action: AuditAction.RESERVE_OVERRIDE_USED,
        actorUserId: actor.id,
        entityType: 'AssembledBouquet',
        entityId: bouquet.id,
        metadata: { productId, requested: quantity },
        context,
        tx,
      });
    }
    if (quantity > stock.quantityOnHand) {
      throw new AppError(
        'INSUFFICIENT_STOCK',
        'Недостаточно цветов на полке',
        {},
        HttpStatus.CONFLICT,
      );
    }

    const fifo = await this.stockFifo.consumeLots(tx, productId, quantity, {
      requireFullCoverage: true,
      mode: 'FEFO',
      requiredUsableUntil: bouquet.order?.fulfillmentDate ?? null,
    });

    const nextOnHand = stock.quantityOnHand - quantity;
    await tx.productStock.update({
      where: { productId },
      data: {
        quantityOnHand: nextOnHand,
        quantityInBouquets: stock.quantityInBouquets + quantity,
        quantityReserved: Math.min(stock.quantityReserved, nextOnHand),
      },
    });

    await tx.stockMovement.create({
      data: {
        productId,
        type: StockMovementType.ASSEMBLE,
        quantity: -quantity,
        balanceAfter: nextOnHand,
        sourceType: 'AssembledBouquet',
        sourceId: bouquet.id,
        comment: `Корректировка ${bouquet.number}`,
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

    const existing = await tx.assembledBouquetComponent.findUnique({
      where: {
        assembledBouquetId_productId: { assembledBouquetId: bouquet.id, productId },
      },
    });
    if (existing) {
      await tx.assembledBouquetComponent.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + quantity },
      });
      for (const a of fifo.allocations) {
        await tx.assembledBouquetComponentLot.create({
          data: {
            componentId: existing.id,
            stockLotId: a.stockLotId,
            quantity: a.quantity,
            remainingQuantity: a.quantity,
            unitPurchasePrice: a.unitPurchasePrice,
          },
        });
      }
    } else {
      await tx.assembledBouquetComponent.create({
        data: {
          assembledBouquetId: bouquet.id,
          productId,
          productNameSnapshot: product.name,
          quantity,
          lots: {
            create: fifo.allocations.map((a) => ({
              stockLotId: a.stockLotId,
              quantity: a.quantity,
              remainingQuantity: a.quantity,
              unitPurchasePrice: a.unitPurchasePrice,
            })),
          },
        },
      });
    }
  }

  private async releaseComponentFromBouquet(
    tx: Tx,
    args: {
      bouquetId: string;
      bouquetNumber: string;
      component: {
        id: string;
        productId: string;
        quantity: number;
        lots: Array<{
          id: string;
          stockLotId: string;
          remainingQuantity: number;
          unitPurchasePrice: Prisma.Decimal | null;
        }>;
      };
      returnQuantity: number;
      damageQuantity: number;
      actorUserId: string;
      keepComponent?: boolean;
      remainingAfter?: number;
    },
  ): Promise<void> {
    const {
      bouquetId,
      bouquetNumber,
      component,
      returnQuantity,
      damageQuantity,
      actorUserId,
      keepComponent,
      remainingAfter,
    } = args;

    const totalRelease = returnQuantity + damageQuantity;
    if (totalRelease <= 0) return;

    // Consume from component lots (FEFO among pinned lots by creation order).
    let leftReturn = returnQuantity;
    let leftDamage = damageQuantity;
    const returnAlloc: Array<{ stockLotId: string; quantity: number }> = [];
    const damageAlloc: Array<{
      stockLotId: string;
      quantity: number;
      unitPurchasePrice: Prisma.Decimal | null;
    }> = [];

    const lots = [...component.lots].sort((a, b) => a.id.localeCompare(b.id));
    for (const lot of lots) {
      if (leftReturn + leftDamage <= 0) break;
      let rem = lot.remainingQuantity;
      if (rem <= 0) continue;

      if (leftDamage > 0 && rem > 0) {
        const take = Math.min(rem, leftDamage);
        damageAlloc.push({
          stockLotId: lot.stockLotId,
          quantity: take,
          unitPurchasePrice: lot.unitPurchasePrice,
        });
        rem -= take;
        leftDamage -= take;
        await tx.assembledBouquetComponentLot.update({
          where: { id: lot.id },
          data: { remainingQuantity: rem },
        });
      }
      if (leftReturn > 0 && rem > 0) {
        const take = Math.min(rem, leftReturn);
        returnAlloc.push({ stockLotId: lot.stockLotId, quantity: take });
        rem -= take;
        leftReturn -= take;
        await tx.assembledBouquetComponentLot.update({
          where: { id: lot.id },
          data: { remainingQuantity: rem },
        });
      }
    }

    if (leftReturn > 0 || leftDamage > 0) {
      throw new AppError(
        'ASSEMBLED_BOUQUET_LOT_MISMATCH',
        'Не удалось сопоставить партии при разборе букета',
        { productId: component.productId, leftReturn, leftDamage },
        HttpStatus.CONFLICT,
      );
    }

    await this.stockBalance.adjustInBouquets(tx, component.productId, -totalRelease);

    if (returnQuantity > 0) {
      await this.stockFifo.returnToLots(tx, returnAlloc);
      const stock = await this.stockBalance.adjustOnHand(tx, component.productId, returnQuantity);
      await tx.stockMovement.create({
        data: {
          productId: component.productId,
          type: StockMovementType.DISASSEMBLE_RETURN,
          quantity: returnQuantity,
          balanceAfter: stock.quantityOnHand,
          sourceType: 'AssembledBouquet',
          sourceId: bouquetId,
          comment: `Возврат из ${bouquetNumber}`,
          createdByUserId: actorUserId,
          allocations: {
            create: returnAlloc.map((a) => ({
              stockLotId: a.stockLotId,
              quantity: a.quantity,
              unitPurchasePrice: null,
            })),
          },
        },
      });
    }

    if (damageQuantity > 0) {
      const stock = await tx.productStock.findUniqueOrThrow({
        where: { productId: component.productId },
      });
      await tx.stockMovement.create({
        data: {
          productId: component.productId,
          type: StockMovementType.DISASSEMBLE_DAMAGE,
          quantity: -damageQuantity,
          balanceAfter: stock.quantityOnHand,
          sourceType: 'AssembledBouquet',
          sourceId: bouquetId,
          comment: `Повреждения при разборе ${bouquetNumber}`,
          createdByUserId: actorUserId,
          allocations: {
            create: damageAlloc.map((a) => ({
              stockLotId: a.stockLotId,
              quantity: a.quantity,
              unitPurchasePrice: a.unitPurchasePrice,
            })),
          },
        },
      });
    }

    if (keepComponent && remainingAfter != null && remainingAfter > 0) {
      await tx.assembledBouquetComponent.update({
        where: { id: component.id },
        data: { quantity: remainingAfter },
      });
    } else if (!keepComponent) {
      await tx.assembledBouquetComponent.delete({ where: { id: component.id } });
    } else if (remainingAfter === 0) {
      await tx.assembledBouquetComponent.delete({ where: { id: component.id } });
    }
  }

  async syncOrderStatusAfterAssembly(tx: Tx, orderId: string, actorUserId: string): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) return;

    const allAssembleReady = await this.areAllAssembleableReady(tx, order);
    const now = new Date();

    if (allAssembleReady) {
      if (order.status !== OrderStatus.READY) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.READY,
            readyAt: order.readyAt ?? now,
            updatedByUserId: actorUserId,
            version: { increment: 1 },
          },
        });
      }
      return;
    }

    const hasAssembled = await tx.assembledBouquet.count({
      where: {
        orderId,
        status: { in: [AssembledBouquetStatus.ASSEMBLED, AssembledBouquetStatus.ISSUED] },
      },
    });

    if (hasAssembled > 0 && order.status === OrderStatus.NEW) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.IN_PROGRESS,
          inProgressAt: now,
          readyAt: null,
          updatedByUserId: actorUserId,
          version: { increment: 1 },
        },
      });
    } else if (order.status === OrderStatus.READY) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.IN_PROGRESS,
          inProgressAt: order.inProgressAt ?? now,
          readyAt: null,
          updatedByUserId: actorUserId,
          version: { increment: 1 },
        },
      });
    } else if (hasAssembled === 0 && order.status === OrderStatus.IN_PROGRESS) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.NEW,
          inProgressAt: null,
          readyAt: null,
          updatedByUserId: actorUserId,
          version: { increment: 1 },
        },
      });
    }
  }

  async syncOrderStatusAfterIssue(tx: Tx, orderId: string, actorUserId: string): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;
    if (order.status === OrderStatus.CANCELLED) return;

    const fullyIssued = await this.isOrderFullyIssued(tx, order);
    if (fullyIssued) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.COMPLETED,
          completedAt: new Date(),
          updatedByUserId: actorUserId,
          version: { increment: 1 },
        },
      });
      // Clear remaining reservations if any
      await this.reservations.releaseAllForOrder(tx, orderId, { reallocate: true });
      return;
    }

    await this.syncOrderStatusAfterAssembly(tx, orderId, actorUserId);
  }

  private async areAllAssembleableReady(
    tx: Tx,
    order: { id: string; items: Array<{ id: string; itemType: string; quantity: number }> },
  ): Promise<boolean> {
    for (const item of order.items) {
      if (item.itemType !== OrderItemType.BOUQUET && item.itemType !== 'BOUQUET') continue;
      const count = await tx.assembledBouquet.count({
        where: {
          orderItemId: item.id,
          status: {
            in: [AssembledBouquetStatus.ASSEMBLED, AssembledBouquetStatus.ISSUED],
          },
        },
      });
      if (count < item.quantity) return false;
    }
    return true;
  }

  private async isOrderFullyIssued(
    tx: Tx,
    order: {
      id: string;
      items: Array<{
        id: string;
        itemType: string;
        quantity: number;
        quantityIssued: number;
        productId: string | null;
      }>;
    },
  ): Promise<boolean> {
    for (const item of order.items) {
      if (item.itemType === OrderItemType.BOUQUET || item.itemType === 'BOUQUET') {
        const issued = await tx.assembledBouquet.count({
          where: { orderItemId: item.id, status: AssembledBouquetStatus.ISSUED },
        });
        const writtenOff = await tx.assembledBouquet.count({
          where: { orderItemId: item.id, status: AssembledBouquetStatus.WRITTEN_OFF },
        });
        // Need issued+writtenOff covering quantity, or quantityIssued field
        if (issued + writtenOff < item.quantity && item.quantityIssued < item.quantity) {
          return false;
        }
      } else if (item.quantityIssued < item.quantity) {
        return false;
      }
    }
    // No ASSEMBLED left for order
    const left = await tx.assembledBouquet.count({
      where: { orderId: order.id, status: AssembledBouquetStatus.ASSEMBLED },
    });
    return left === 0;
  }

  private async nextBouquetNumber(tx: Tx, isoDate: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO assembled_bouquet_daily_counters ("businessDate", "lastNumber", "updatedAt")
      VALUES (${parseIsoDateOnly(isoDate)}, 1, NOW())
      ON CONFLICT ("businessDate")
      DO UPDATE SET
        "lastNumber" = assembled_bouquet_daily_counters."lastNumber" + 1,
        "updatedAt" = NOW()
      RETURNING "lastNumber"
    `;
    const seq = rows[0]?.lastNumber;
    if (!seq) {
      throw new AppError(
        'BOUQUET_NUMBER_FAILED',
        'Не удалось выделить номер букета',
        {},
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return `AB-${toOrderNumberDatePrefix(isoDate)}-${String(seq).padStart(3, '0')}`;
  }

  private requirePermission(actor: AuthenticatedUser, permission: Permission): void {
    if (!roleHasPermission(actor.role as Role, permission)) {
      throw new AppError('FORBIDDEN', 'Недостаточно прав', {}, HttpStatus.FORBIDDEN);
    }
  }

  private readonly detailInclude = {
    assembledBy: { select: { name: true } },
    order: { select: { number: true } },
    components: {
      include: { lots: true },
      orderBy: { sortOrder: 'asc' as const },
    },
  };

  private toListItem(
    row: {
      id: string;
      number: string;
      status: AssembledBouquetStatus | string;
      orderId: string | null;
      orderItemId: string | null;
      bouquetTemplateId: string | null;
      nameSnapshot: string;
      version: number;
      unitCost: Prisma.Decimal | null;
      hasUncostedComponents: boolean;
      assembledAt: Date;
      assembledBy?: { name: string } | null;
      order?: { number: string } | null;
    },
    actor: AuthenticatedUser,
  ): AssembledBouquetListItem {
    const canSeeCost = roleHasPermission(actor.role as Role, Permission.PURCHASE_PRICE_VIEW);
    return {
      id: row.id,
      number: row.number,
      status: row.status as AssembledBouquetStatus,
      orderId: row.orderId,
      orderNumber: row.order?.number ?? null,
      orderItemId: row.orderItemId,
      bouquetTemplateId: row.bouquetTemplateId,
      nameSnapshot: row.nameSnapshot,
      version: row.version,
      unitCost: canSeeCost ? this.money(row.unitCost) : null,
      hasUncostedComponents: row.hasUncostedComponents,
      assembledAt: row.assembledAt.toISOString(),
      assembledByName: row.assembledBy?.name ?? '',
    };
  }

  private toDetail(
    row: {
      id: string;
      number: string;
      status: AssembledBouquetStatus | string;
      orderId: string | null;
      orderItemId: string | null;
      bouquetTemplateId: string | null;
      nameSnapshot: string;
      version: number;
      unitCost: Prisma.Decimal | null;
      hasUncostedComponents: boolean;
      assembledAt: Date;
      disassembleReason: string | null;
      writeOffReason: string | null;
      issuedAt: Date | null;
      disassembledAt: Date | null;
      assembledBy?: { name: string } | null;
      order?: { number: string } | null;
      components: Array<{
        id: string;
        productId: string;
        productNameSnapshot: string;
        quantity: number;
        sortOrder: number;
        lots: Array<{
          stockLotId: string;
          quantity: number;
          remainingQuantity: number;
          unitPurchasePrice: Prisma.Decimal | null;
        }>;
      }>;
    },
    actor: AuthenticatedUser,
  ): AssembledBouquetDetail {
    const canSeeCost = roleHasPermission(actor.role as Role, Permission.PURCHASE_PRICE_VIEW);
    return {
      ...this.toListItem(row, actor),
      disassembleReason: row.disassembleReason,
      writeOffReason: row.writeOffReason,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      disassembledAt: row.disassembledAt?.toISOString() ?? null,
      components: row.components.map((c) => ({
        id: c.id,
        productId: c.productId,
        productNameSnapshot: c.productNameSnapshot,
        quantity: c.quantity,
        sortOrder: c.sortOrder,
        lots: c.lots.map((l) => ({
          stockLotId: l.stockLotId,
          quantity: l.quantity,
          remainingQuantity: l.remainingQuantity,
          unitPurchasePrice: canSeeCost ? this.money(l.unitPurchasePrice) : null,
        })),
      })),
    };
  }

  private money(value: Prisma.Decimal | null | undefined): MoneyString | null {
    if (value == null) return null;
    return value.toFixed(2);
  }
}
