export const API_PREFIX = '/api/v1';

export type ServiceStatus = 'ok' | 'degraded';
export type DatabaseStatus = 'up' | 'down';

export interface HealthResponse {
  status: ServiceStatus;
  database: DatabaseStatus;
}

export enum Role {
  FLORIST = 'FLORIST',
  MANAGER = 'MANAGER',
  DIRECTOR = 'DIRECTOR',
}

export const ROLES = [Role.FLORIST, Role.MANAGER, Role.DIRECTOR] as const;

export enum Permission {
  EMPLOYEES_VIEW = 'employees.view',
  EMPLOYEES_MANAGE = 'employees.manage',

  PRODUCTS_VIEW = 'products.view',
  PRODUCTS_MANAGE = 'products.manage',

  INVENTORY_VIEW = 'inventory.view',
  /** Enter physical counts during stocktake. */
  INVENTORY_COUNT = 'inventory.count',
  /** Start / complete / cancel inventory sessions. */
  INVENTORY_MANAGE = 'inventory.manage',
  /** Manual stock write-off (decrease only). */
  INVENTORY_ADJUST = 'inventory.adjust',

  SUPPLIES_VIEW = 'supplies.view',
  SUPPLIES_CREATE = 'supplies.create',
  SUPPLIES_POST = 'supplies.post',
  SUPPLIES_CORRECT = 'supplies.correct',

  BOUQUETS_VIEW = 'bouquets.view',
  BOUQUETS_MANAGE = 'bouquets.manage',

  ORDERS_VIEW = 'orders.view',
  ORDERS_CREATE = 'orders.create',
  ORDERS_UPDATE = 'orders.update',
  /** Transition NEW↔READY / READY→COMPLETED. */
  ORDERS_STATUS = 'orders.status',
  ORDERS_CANCEL = 'orders.cancel',
  /** Apply order discount / unit price override. */
  ORDERS_DISCOUNT = 'orders.discount',

  PURCHASE_PRICE_VIEW = 'purchase_price.view',

  AUDIT_VIEW = 'audit.view',

  SETTINGS_MANAGE = 'settings.manage',
}

export const ALL_PERMISSIONS = Object.values(Permission);

const FLORIST_PERMISSIONS: readonly Permission[] = [
  Permission.PRODUCTS_VIEW,
  Permission.INVENTORY_VIEW,
  Permission.INVENTORY_COUNT,
  Permission.BOUQUETS_VIEW,
  Permission.ORDERS_VIEW,
  Permission.ORDERS_CREATE,
  Permission.ORDERS_UPDATE,
  Permission.ORDERS_STATUS,
];

const MANAGER_PERMISSIONS: readonly Permission[] = [
  ...FLORIST_PERMISSIONS,
  Permission.EMPLOYEES_VIEW,
  Permission.PRODUCTS_MANAGE,
  Permission.INVENTORY_MANAGE,
  Permission.INVENTORY_ADJUST,
  Permission.SUPPLIES_VIEW,
  Permission.SUPPLIES_CREATE,
  Permission.SUPPLIES_POST,
  Permission.SUPPLIES_CORRECT,
  Permission.BOUQUETS_MANAGE,
  Permission.ORDERS_CANCEL,
  Permission.ORDERS_DISCOUNT,
  Permission.PURCHASE_PRICE_VIEW,
  Permission.AUDIT_VIEW,
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.FLORIST]: FLORIST_PERMISSIONS,
  [Role.MANAGER]: MANAGER_PERMISSIONS,
  [Role.DIRECTOR]: ALL_PERMISSIONS,
};

export function getPermissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function roleHasAllPermissions(role: Role, permissions: Permission[]): boolean {
  return permissions.every((permission) => roleHasPermission(role, permission));
}

export interface AuthUser {
  id: string;
  name: string;
  login: string;
  email: string | null;
  role: Role;
  permissions: Permission[];
}

export interface EmployeeListItem {
  id: string;
  name: string;
  login: string;
  email: string | null;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  /** Raw User-Agent from last successful login. */
  lastLoginUserAgent: string | null;
  /** True when at least one non-revoked, non-expired session exists. */
  hasActiveSession: boolean;
  activeSessionCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Short human label for a browser User-Agent string. */
export function formatBrowserLabel(userAgent: string | null | undefined): string {
  if (!userAgent?.trim()) return '—';
  const ua = userAgent;
  let browser = 'Браузер';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/Opera|OPR\//i.test(ua)) browser = 'Opera';

  let os = '';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return os ? `${browser} · ${os}` : browser;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export enum AuditAction {
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  EMPLOYEE_CREATED = 'EMPLOYEE_CREATED',
  EMPLOYEE_UPDATED = 'EMPLOYEE_UPDATED',
  EMPLOYEE_DEACTIVATED = 'EMPLOYEE_DEACTIVATED',
  EMPLOYEE_REACTIVATED = 'EMPLOYEE_REACTIVATED',
  SESSION_REVOKED = 'SESSION_REVOKED',
  PRODUCT_CREATED = 'PRODUCT_CREATED',
  PRODUCT_UPDATED = 'PRODUCT_UPDATED',
  PRODUCT_DEACTIVATED = 'PRODUCT_DEACTIVATED',
  PRODUCT_REACTIVATED = 'PRODUCT_REACTIVATED',
  STOCK_MANUAL_ADJUSTED = 'STOCK_MANUAL_ADJUSTED',
  STOCK_WRITTEN_OFF = 'STOCK_WRITTEN_OFF',
  SUPPLY_CREATED = 'SUPPLY_CREATED',
  SUPPLY_UPDATED = 'SUPPLY_UPDATED',
  SUPPLY_POSTED = 'SUPPLY_POSTED',
  SUPPLY_CANCELLED = 'SUPPLY_CANCELLED',
  SUPPLY_CORRECTION_CREATED = 'SUPPLY_CORRECTION_CREATED',
  SUPPLY_CORRECTED = 'SUPPLY_CORRECTED',
  SUPPLY_MARKED_PAID = 'SUPPLY_MARKED_PAID',
  SUPPLY_MARKED_UNPAID = 'SUPPLY_MARKED_UNPAID',
  SUPPLIER_CREATED = 'SUPPLIER_CREATED',
  SUPPLIER_UPDATED = 'SUPPLIER_UPDATED',
  SUPPLIER_DEACTIVATED = 'SUPPLIER_DEACTIVATED',
  SUPPLIER_REACTIVATED = 'SUPPLIER_REACTIVATED',
  INVENTORY_CREATED = 'INVENTORY_CREATED',
  INVENTORY_STARTED = 'INVENTORY_STARTED',
  INVENTORY_COMPLETED = 'INVENTORY_COMPLETED',
  INVENTORY_CANCELLED = 'INVENTORY_CANCELLED',
  BOUQUET_CREATED = 'BOUQUET_CREATED',
  BOUQUET_UPDATED = 'BOUQUET_UPDATED',
  BOUQUET_DEACTIVATED = 'BOUQUET_DEACTIVATED',
  BOUQUET_REACTIVATED = 'BOUQUET_REACTIVATED',
  ORDER_CREATED = 'ORDER_CREATED',
  ORDER_UPDATED = 'ORDER_UPDATED',
  ORDER_STATUS_CHANGED = 'ORDER_STATUS_CHANGED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  STOCK_RESERVATIONS_ALLOCATED = 'STOCK_RESERVATIONS_ALLOCATED',
}

export const ROLE_LABELS_RU: Record<Role, string> = {
  [Role.FLORIST]: 'Флорист',
  [Role.MANAGER]: 'Менеджер',
  [Role.DIRECTOR]: 'Директор',
};

export enum ProductType {
  FLOWER = 'FLOWER',
  SERVICE = 'SERVICE',
}

export enum Unit {
  PIECE = 'PIECE',
}

export enum StockMovementType {
  SUPPLY = 'SUPPLY',
  SUPPLY_REVERSAL = 'SUPPLY_REVERSAL',
  SALE = 'SALE',
  WRITE_OFF = 'WRITE_OFF',
  MANUAL_WRITE_OFF = 'MANUAL_WRITE_OFF',
  RETURN = 'RETURN',
  INVENTORY_ADJUSTMENT = 'INVENTORY_ADJUSTMENT',
  MANUAL_ADJUSTMENT = 'MANUAL_ADJUSTMENT',
}

export enum SupplyStatus {
  DRAFT = 'DRAFT',
  POSTED = 'POSTED',
  CANCELLED = 'CANCELLED',
}

export enum InventoryStatus {
  DRAFT = 'DRAFT',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum StockLotSource {
  SUPPLY = 'SUPPLY',
  INVENTORY = 'INVENTORY',
}

export const PRODUCT_TYPE_LABELS_RU: Record<ProductType, string> = {
  [ProductType.FLOWER]: 'Цветок',
  [ProductType.SERVICE]: 'Услуга',
};

export const UNIT_LABELS_RU: Record<Unit, string> = {
  [Unit.PIECE]: 'шт.',
};

export const STOCK_MOVEMENT_TYPE_LABELS_RU: Record<StockMovementType, string> = {
  [StockMovementType.SUPPLY]: 'Поставка',
  [StockMovementType.SUPPLY_REVERSAL]: 'Отмена поставки',
  [StockMovementType.SALE]: 'Продажа',
  [StockMovementType.WRITE_OFF]: 'Списание',
  [StockMovementType.MANUAL_WRITE_OFF]: 'Списание',
  [StockMovementType.RETURN]: 'Возврат',
  [StockMovementType.INVENTORY_ADJUSTMENT]: 'Инвентаризация',
  [StockMovementType.MANUAL_ADJUSTMENT]: 'Ручная корректировка',
};

export const SUPPLY_STATUS_LABELS_RU: Record<SupplyStatus, string> = {
  [SupplyStatus.DRAFT]: 'Черновик',
  [SupplyStatus.POSTED]: 'Проведена',
  [SupplyStatus.CANCELLED]: 'Отменена',
};

export const INVENTORY_STATUS_LABELS_RU: Record<InventoryStatus, string> = {
  [InventoryStatus.DRAFT]: 'Черновик',
  [InventoryStatus.IN_PROGRESS]: 'В процессе',
  [InventoryStatus.COMPLETED]: 'Завершена',
  [InventoryStatus.CANCELLED]: 'Отменена',
};

/** Money amounts in API JSON are decimal strings, e.g. "12.50". */
export type MoneyString = string;

export interface ProductStockDto {
  quantityOnHand: number;
  quantityReserved: number;
  availableQuantity: number;
}

export interface ProductListItem {
  id: string;
  name: string;
  sku: string | null;
  type: ProductType;
  description: string | null;
  unit: Unit;
  purchasePrice?: MoneyString | null;
  /**
   * Weighted average of costed remaining lots.
   * Null when no remaining costed stock OR when uncosted stock exists.
   * Omitted without purchase_price.view.
   */
  averagePurchaseCost?: MoneyString | null;
  /** Min unit purchase price among remaining costed lots. */
  minPurchaseCost?: MoneyString | null;
  /** Max unit purchase price among remaining costed lots. */
  maxPurchaseCost?: MoneyString | null;
  /** Distinct posted supplies that included this product. */
  supplyCount?: number;
  /** True when remaining lots include unknown purchase cost. Omitted without purchase_price.view. */
  hasUncostedStock?: boolean;
  salePrice: MoneyString | null;
  isActive: boolean;
  stock: ProductStockDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductListResult {
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface StockMovementListItem {
  id: string;
  productId: string;
  type: StockMovementType;
  quantity: number;
  balanceAfter: number;
  sourceType: string | null;
  sourceId: string | null;
  comment: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface StockMovementListResult {
  items: StockMovementListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface StockWriteOffResult {
  productId: string;
  quantityOnHand: number;
  quantityReserved: number;
  availableQuantity: number;
  movement: StockMovementListItem;
}

export type StockAdjustResult = StockWriteOffResult;

export interface SupplyItemDto {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPurchasePrice?: MoneyString;
  lineTotal?: MoneyString;
}

export interface SupplierListItem {
  id: string;
  name: string;
  phone: string | null;
  comment: string | null;
  isActive: boolean;
  supplyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierListResult {
  items: SupplierListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SupplyListItem {
  id: string;
  number: number;
  numberLabel: string;
  status: SupplyStatus;
  documentDate: string;
  supplierId: string;
  supplierName: string;
  paymentDueDate: string | null;
  paidAt: string | null;
  isPaid: boolean;
  comment: string | null;
  correctionOfSupplyId: string | null;
  correctionOfNumber: number | null;
  itemCount: number;
  totalQuantity: number;
  totalAmount?: MoneyString;
  createdByName: string;
  postedByName: string | null;
  createdAt: string;
  postedAt: string | null;
}

export interface SupplyListResult {
  items: SupplyListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SupplyDetail extends SupplyListItem {
  correctionReason: string | null;
  createdByUserId: string;
  postedByUserId: string | null;
  cancelledByUserId: string | null;
  paidByUserId: string | null;
  paidByName: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  correctedBySupplyId: string | null;
  correctedByNumber: number | null;
  items: SupplyItemDto[];
}

export interface SystemSettingsDto {
  health: HealthResponse;
  businessTimeZone: string;
  nodeEnv: string;
  webUrl: string;
  apiPrefix: string;
}

export interface AddressSuggestionDto {
  label: string;
  addressText: string;
  latitude: number | null;
  longitude: number | null;
  provider: string;
  providerPlaceId: string | null;
}

export interface InventoryItemDto {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  expectedQuantity: number;
  countedQuantity: number | null;
  difference: number | null;
  countedByUserId: string | null;
  countedByName: string | null;
  countedAt: string | null;
}

export interface InventoryListItem {
  id: string;
  number: number;
  numberLabel: string;
  status: InventoryStatus;
  comment: string | null;
  itemCount: number;
  countedItemCount: number;
  differenceItemCount: number;
  createdByName: string;
  completedByName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface InventoryListResult {
  items: InventoryListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface InventoryDetail extends InventoryListItem {
  createdByUserId: string;
  completedByUserId: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  positiveQuantity: number;
  negativeQuantity: number;
  items: InventoryItemDto[];
}

export interface ActiveInventoryInfo {
  id: string;
  number: number;
  numberLabel: string;
  status: InventoryStatus;
  startedAt: string | null;
  itemCount: number;
  countedItemCount: number;
}

/** Recipe component of a Bouquet (not stock). */
export interface BouquetItemDto {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  productType: ProductType;
  unit: Unit;
  quantity: number;
  isActive: boolean;
  /** FLOWER available qty (onHand - reserved). Null for SERVICE. */
  availableStock: number | null;
  /** Current unit cost if purchase_price.view. Omitted otherwise. */
  currentComponentCost?: MoneyString | null;
  /** quantity × currentComponentCost if known. Omitted without purchase_price.view. */
  estimatedLineCost?: MoneyString | null;
}

export interface BouquetListItem {
  id: string;
  name: string;
  description: string | null;
  salePrice: MoneyString;
  isActive: boolean;
  version: number;
  componentCount: number;
  flowerComponentCount: number;
  /** Compact composition preview for list UI. */
  compositionPreview: string;
  availableBouquets: number;
  hasInactiveComponents: boolean;
  /** Omitted without purchase_price.view. */
  estimatedCurrentCost?: MoneyString | null;
  hasUnknownCost?: boolean;
  estimatedMargin?: MoneyString | null;
  /** Percent string e.g. "37.00". Omitted without purchase_price.view. */
  estimatedMarginPercent?: MoneyString | null;
  createdAt: string;
  updatedAt: string;
}

export interface BouquetListResult {
  items: BouquetListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface BouquetDetail extends BouquetListItem {
  items: BouquetItemDto[];
}

export enum OrderStatus {
  NEW = 'NEW',
  READY = 'READY',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum FulfillmentType {
  PICKUP = 'PICKUP',
  DELIVERY = 'DELIVERY',
}

export enum OrderItemType {
  PRODUCT = 'PRODUCT',
  BOUQUET = 'BOUQUET',
}

export enum DiscountType {
  PERCENT = 'PERCENT',
  FIXED = 'FIXED',
}

export const ORDER_STATUS_LABELS_RU: Record<OrderStatus, string> = {
  [OrderStatus.NEW]: 'Новый',
  [OrderStatus.READY]: 'Готов',
  [OrderStatus.COMPLETED]: 'Завершён',
  [OrderStatus.CANCELLED]: 'Отменён',
};

export const FULFILLMENT_TYPE_LABELS_RU: Record<FulfillmentType, string> = {
  [FulfillmentType.PICKUP]: 'Самовывоз',
  [FulfillmentType.DELIVERY]: 'Доставка',
};

export const DISCOUNT_TYPE_LABELS_RU: Record<DiscountType, string> = {
  [DiscountType.PERCENT]: 'Процент',
  [DiscountType.FIXED]: 'Фиксированная',
};

/** UI label for READY/COMPLETED depending on fulfillment. */
export function orderStatusLabelRu(status: OrderStatus, fulfillmentType: FulfillmentType): string {
  if (status === OrderStatus.READY) {
    return fulfillmentType === FulfillmentType.DELIVERY ? 'Готов к доставке' : 'Готов к выдаче';
  }
  if (status === OrderStatus.COMPLETED) {
    return fulfillmentType === FulfillmentType.DELIVERY ? 'Доставлен' : 'Выдан';
  }
  return ORDER_STATUS_LABELS_RU[status];
}

export interface OrderItemComponentDto {
  id: string;
  productId: string;
  productNameSnapshot: string;
  productTypeSnapshot: ProductType;
  unitSnapshot: Unit;
  quantityPerItem: number;
  totalQuantity: number;
  sortOrder: number;
}

export interface OrderItemDto {
  id: string;
  itemType: OrderItemType;
  productId: string | null;
  bouquetId: string | null;
  nameSnapshot: string;
  quantity: number;
  unitPrice: MoneyString;
  lineSubtotal: MoneyString;
  sortOrder: number;
  compositionPreview: string | null;
  components: OrderItemComponentDto[];
}

export interface OrderRequirementDto {
  productId: string;
  productName: string;
  requiredQuantity: number;
  reservedQuantity: number;
  shortageQuantity: number;
}

export interface OrderListItem {
  id: string;
  number: string;
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  fulfillmentDate: string;
  fulfillmentTimeFrom: string | null;
  fulfillmentTimeTo: string | null;
  customerName: string;
  customerPhone: string;
  effectiveRecipientName: string;
  effectiveRecipientPhone: string;
  deliveryAddressText: string | null;
  itemCount: number;
  compositionSummary: string;
  total: MoneyString;
  version: number;
  attention: 'none' | 'overdue' | 'attention' | 'past_date';
  hasShortage: boolean;
  shortageProductCount: number;
  createdAt: string;
}

export interface OrderListResult {
  items: OrderListItem[];
  total: number;
  page: number;
  limit: number;
  summary: {
    total: number;
    delivery: number;
    pickup: number;
    byStatus: Record<OrderStatus, number>;
  };
}

export interface OrderDetail extends OrderListItem {
  orderComment: string | null;
  deliveryComment: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  deliveryProvider: string | null;
  deliveryProviderPlaceId: string | null;
  subtotal: MoneyString;
  discountType: DiscountType | null;
  discountValue: MoneyString | null;
  discountAmount: MoneyString;
  /** Present when completed and caller has purchase_price.view; null if uncosted. */
  actualCost: MoneyString | null;
  hasUncostedConsumption: boolean;
  /** total − actualCost when both known; else null. Requires purchase_price.view. */
  grossProfit: MoneyString | null;
  createdByUserId: string;
  createdByName: string;
  updatedByUserId: string | null;
  updatedByName: string | null;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  items: OrderItemDto[];
  requirements: OrderRequirementDto[];
}

export interface BusinessTimeInfo {
  timeZone: string;
  businessDate: string;
  nowIso: string;
}
