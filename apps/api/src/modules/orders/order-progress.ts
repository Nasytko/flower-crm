import { Prisma } from '@erp/database';
import {
  AssembledBouquetStatus,
  FulfillmentType,
  OrderFulfillmentMode,
  OrderItemType,
  OrderStatus,
  type OrderFulfillmentProgressDto,
  type OrderPaymentSummaryDto,
} from '@erp/shared';

/** Structural subset of an Order row (with items + assembledBouquets) used for progress. */
export interface OrderProgressInput {
  status: OrderStatus | string;
  fulfillmentType: FulfillmentType | string;
  fulfillmentMode?: OrderFulfillmentMode | string | null;
  createdAt: Date;
  inProgressAt?: Date | null;
  readyAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  createdBy?: { name: string } | null;
  items: Array<{
    itemType: OrderItemType | string;
    quantity: number;
    quantityIssued: number;
    assembledBouquets?: Array<{ status: AssembledBouquetStatus | string }>;
  }>;
}

type Stage = OrderFulfillmentProgressDto['stages'][number];
type StageState = Stage['state'];

export const NO_CONFIRMATION_HINT = 'Нет подтверждения';
export const DELIVERY_NOT_CONFIRMED = 'Доставка не подтверждена';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function stage(
  id: string,
  label: string,
  state: StageState,
  at: Date | null | undefined = null,
  byName: string | null = null,
  hint: string | null = null,
): Stage {
  return { id, label, state, at: iso(at), byName, hint };
}

/**
 * Fulfillment progress for the order card.
 *
 * Courier stages never claim success: there is no courier model, so DELIVERY orders always
 * show «Нет подтверждения» for handover/delivery and nextAction says
 * «Доставка не подтверждена» once the goods have left the warehouse.
 */
export function buildFulfillmentProgress(
  order: OrderProgressInput,
  payment?: Pick<OrderPaymentSummaryDto, 'remainingDue' | 'pendingAmount' | 'paymentStatus'> | null,
): OrderFulfillmentProgressDto {
  const status = order.status as OrderStatus;
  const fulfillmentType = order.fulfillmentType as FulfillmentType;
  const fulfillmentMode =
    (order.fulfillmentMode as OrderFulfillmentMode | null | undefined) ??
    OrderFulfillmentMode.SCHEDULED;
  const cancelled = status === OrderStatus.CANCELLED;
  const walkIn = fulfillmentMode === OrderFulfillmentMode.WALK_IN;
  const delivery = !walkIn && fulfillmentType === FulfillmentType.DELIVERY;

  // --- counts ---------------------------------------------------------------
  let bouquetRequiredCount = 0;
  let bouquetAssembledCount = 0;
  let productRequiredCount = 0;
  let productIssuedCount = 0;
  for (const item of order.items) {
    if (item.itemType === OrderItemType.BOUQUET) {
      bouquetRequiredCount += item.quantity;
      const physical = (item.assembledBouquets ?? []).filter(
        (b) =>
          b.status === AssembledBouquetStatus.ASSEMBLED ||
          b.status === AssembledBouquetStatus.ISSUED,
      ).length;
      bouquetAssembledCount += Math.min(item.quantity, physical);
    } else {
      productRequiredCount += item.quantity;
      productIssuedCount += Math.min(item.quantity, item.quantityIssued);
    }
  }

  // --- stages ---------------------------------------------------------------
  const created = stage(
    'created',
    walkIn ? 'Оформлен' : 'Принят',
    'done',
    order.createdAt,
    order.createdBy?.name ?? null,
  );
  const stages: Stage[] = [created];

  const phase = (done: boolean, current: boolean): StageState =>
    cancelled ? 'skipped' : done ? 'done' : current ? 'current' : 'pending';

  const assemblyDone = status === OrderStatus.READY || status === OrderStatus.COMPLETED;
  const assemblyLabel =
    bouquetRequiredCount > 0
      ? `Сборка (${bouquetAssembledCount}/${bouquetRequiredCount})`
      : 'Подготовка';
  stages.push(
    stage(
      'assembly',
      assemblyLabel,
      phase(assemblyDone, status === OrderStatus.NEW || status === OrderStatus.IN_PROGRESS),
      order.inProgressAt ?? null,
    ),
  );

  if (!walkIn) {
    stages.push(stage('ready', 'Готов', phase(assemblyDone, false), order.readyAt ?? null));
  }

  const completed = status === OrderStatus.COMPLETED;
  const issuedLabel = walkIn ? 'Выдан' : delivery ? 'Отпущен со склада' : 'Выдан клиенту';
  stages.push(
    stage(
      'issued',
      issuedLabel,
      phase(completed, status === OrderStatus.READY),
      order.completedAt ?? null,
    ),
  );

  if (delivery) {
    // No courier model: never mark as done.
    const courierState: StageState = cancelled ? 'skipped' : 'pending';
    stages.push(
      stage('courier_handover', 'Передан курьеру', courierState, null, null, NO_CONFIRMATION_HINT),
      stage('delivered', 'Доставлен', courierState, null, null, NO_CONFIRMATION_HINT),
    );
  }

  // --- next action ----------------------------------------------------------
  const nextAction = cancelled
    ? null
    : composeNextAction({
        status,
        walkIn,
        delivery,
        bouquetRequiredCount,
        bouquetAssembledCount,
        productRequiredCount,
        productIssuedCount,
        payment: payment ?? null,
      });

  return {
    fulfillmentType,
    fulfillmentMode,
    status,
    stages,
    bouquetAssembledCount,
    bouquetRequiredCount,
    productIssuedCount,
    productRequiredCount,
    nextAction,
  };
}

function composeNextAction(args: {
  status: OrderStatus;
  walkIn: boolean;
  delivery: boolean;
  bouquetRequiredCount: number;
  bouquetAssembledCount: number;
  productRequiredCount: number;
  productIssuedCount: number;
  payment: Pick<OrderPaymentSummaryDto, 'remainingDue' | 'pendingAmount' | 'paymentStatus'> | null;
}): string | null {
  const parts: string[] = [];
  const due = args.payment ? new Prisma.Decimal(args.payment.remainingDue) : null;
  const pending = args.payment ? new Prisma.Decimal(args.payment.pendingAmount) : null;

  switch (args.status) {
    case OrderStatus.NEW:
    case OrderStatus.IN_PROGRESS: {
      const left = args.bouquetRequiredCount - args.bouquetAssembledCount;
      if (left > 0) {
        parts.push(`Собрать букеты: ${args.bouquetAssembledCount}/${args.bouquetRequiredCount}`);
      } else if (args.productRequiredCount > args.productIssuedCount) {
        parts.push('Подготовить товары к выдаче');
      } else {
        parts.push('Подтвердить готовность');
      }
      break;
    }
    case OrderStatus.READY:
      parts.push(args.delivery ? 'Отпустить заказ для доставки' : 'Выдать клиенту');
      break;
    case OrderStatus.COMPLETED:
      if (args.delivery) parts.push(DELIVERY_NOT_CONFIRMED);
      break;
    default:
      break;
  }

  if (due && due.greaterThan(0) && args.status !== OrderStatus.COMPLETED) {
    parts.push(`Принять оплату: ${due.toFixed(2)}`);
  } else if (due && due.greaterThan(0) && args.status === OrderStatus.COMPLETED) {
    parts.push(`Долг по оплате: ${due.toFixed(2)}`);
  }
  if (pending && pending.greaterThan(0)) {
    parts.push(`Ожидает подтверждения оплаты: ${pending.toFixed(2)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
