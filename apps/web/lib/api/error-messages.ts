import { ApiClientError } from '@/lib/api/client';

/** Known API error codes → stable Russian copy for UI (server message may already be RU). */
const ERROR_MESSAGES_RU: Record<string, string> = {
  ORDER_HAS_SHORTAGE: 'Заказ нельзя отметить готовым: не хватает товара.',
  ORDER_CONFLICT: 'Заказ был изменён другим пользователем. Обновите страницу.',
  ORDER_NOT_FOUND: 'Заказ не найден',
  ORDER_NOT_EDITABLE: 'Заказ нельзя изменить в текущем статусе',
  ORDER_INVALID_STATUS_TRANSITION: 'Недопустимый переход статуса заказа',
  ORDER_EMPTY: 'Добавьте хотя бы одну позицию',
  ORDER_INVALID_DISCOUNT: 'Некорректная скидка',
  ORDER_INVALID_TIME: 'Некорректный интервал времени',
  ORDER_INVALID_FULFILLMENT: 'Некорректные параметры исполнения',
  ORDER_INACTIVE_PRODUCT: 'В заказе есть неактивный товар',
  ORDER_INACTIVE_BOUQUET: 'В заказе есть неактивный букет',
  INVENTORY_IN_PROGRESS: 'Склад заморожен: идёт инвентаризация',
  INVENTORY_BELOW_RESERVED: 'Факт не может быть меньше зарезервированного количества',
  INVENTORY_STOCK_CHANGED: 'Остатки изменились с момента снимка. Начните инвентаризацию заново.',
  INVENTORY_INCOMPLETE: 'Отметьте количество по всем позициям',
  INVENTORY_NOT_EDITABLE: 'Инвентаризация уже закрыта',
  INSUFFICIENT_STOCK: 'Недостаточно доступного остатка',
  BOUQUET_CONFLICT: 'Букет был изменён другим пользователем. Обновите страницу.',
  BOUQUET_NOT_FOUND: 'Букет не найден',
  PRODUCT_NOT_FOUND: 'Товар не найден',
  PRODUCT_SKU_ALREADY_EXISTS: 'SKU уже занят',
  PRODUCT_INACTIVE: 'Товар неактивен',
  STOCK_NOT_SUPPORTED: 'Операция доступна только для цветов',
  INVALID_WRITE_OFF: 'Некорректное списание',
  SUPPLY_NOT_FOUND: 'Поставка не найдена',
  SUPPLY_NOT_EDITABLE: 'Поставку нельзя изменить',
  SUPPLY_ALREADY_POSTED: 'Поставка уже проведена',
  SUPPLY_EMPTY: 'Добавьте хотя бы одну позицию',
  SUPPLY_CORRECTION_INVALID: 'Коррекция поставки недоступна',
  RESERVATION_INVARIANT_VIOLATION: 'Нарушение инварианта резерва',
  FORBIDDEN: 'Недостаточно прав',
  UNAUTHORIZED: 'Требуется аутентификация',
  VALIDATION_ERROR: 'Проверьте введённые данные',
  LOGIN_TAKEN: 'Логин уже занят',
  EMAIL_TAKEN: 'Email уже занят',
  NOT_FOUND: 'Не найдено',
};

export function messageForErrorCode(code: string | undefined | null): string | null {
  if (!code) return null;
  return ERROR_MESSAGES_RU[code] ?? null;
}

/** Prefer mapped RU text for known codes; otherwise use API message / fallback. */
export function userFacingError(err: unknown, fallback = 'Произошла ошибка'): string {
  if (err instanceof ApiClientError) {
    return messageForErrorCode(err.body.code) ?? err.body.message ?? fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
