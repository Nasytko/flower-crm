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

export enum AuthStrength {
  PASSWORD = 'PASSWORD',
  PIN = 'PIN',
}

export enum DeviceAccessMode {
  ALL_PIN_USERS = 'ALL_PIN_USERS',
  SELECTED_USERS = 'SELECTED_USERS',
}

export enum WorkSessionCloseReason {
  MANUAL = 'MANUAL',
  LOGOUT = 'LOGOUT',
  EXPIRED = 'EXPIRED',
  DEVICE_REVOKED = 'DEVICE_REVOKED',
  FORCE = 'FORCE',
}

export type PinStatus = 'DISABLED' | 'NOT_SET' | 'ACTIVE' | 'TEMP_LOCKED';

/** Fixed PIN length (leading zeros preserved as string). */
export const PIN_LENGTH = 6;

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
  /** Transition order statuses (incl. IN_PROGRESS / READY / COMPLETED). */
  ORDERS_STATUS = 'orders.status',
  ORDERS_CANCEL = 'orders.cancel',
  /** Apply order discount / unit price override. */
  ORDERS_DISCOUNT = 'orders.discount',
  /** Assemble / adjust / disassemble physical bouquets. */
  ORDERS_ASSEMBLE = 'orders.assemble',
  /** Issue assembled bouquets or direct-issue products. */
  ORDERS_ISSUE = 'orders.issue',
  /** Override higher-priority planned reserve when assembling a later order. */
  ORDERS_RESERVE_OVERRIDE = 'orders.reserve_override',

  /** Access POS / sales UI and working carts. */
  POS_ACCESS = 'pos.access',
  /** Confirm POS cart → Order. */
  POS_SELL = 'pos.sell',
  /** Override recommended unit price on a POS line. */
  POS_PRICE_OVERRIDE = 'pos.price_override',
  /** Apply line or cart discounts in POS (also accepts ORDERS_DISCOUNT). */
  POS_DISCOUNT = 'pos.discount',
  /** Register a payment (charge) against an order. */
  PAYMENTS_CREATE = 'payments.create',
  /** Confirm PENDING external/manual payment. */
  PAYMENTS_CONFIRM = 'payments.confirm',
  /** Register refund (foundation; may stay PENDING without provider). */
  PAYMENTS_REFUND = 'payments.refund',
  /** Open / close cash shifts and float movements. */
  CASH_SHIFT_MANAGE = 'cash.shift_manage',

  PURCHASE_PRICE_VIEW = 'purchase_price.view',

  AUDIT_VIEW = 'audit.view',

  SETTINGS_MANAGE = 'settings.manage',

  /** Org security policy + trusted devices (director). */
  SECURITY_POLICY_MANAGE = 'security.policy.manage',
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
  Permission.ORDERS_ASSEMBLE,
  Permission.ORDERS_ISSUE,
  Permission.POS_ACCESS,
  Permission.POS_SELL,
  Permission.PAYMENTS_CREATE,
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
  Permission.ORDERS_RESERVE_OVERRIDE,
  Permission.POS_PRICE_OVERRIDE,
  Permission.POS_DISCOUNT,
  Permission.PAYMENTS_CONFIRM,
  Permission.PAYMENTS_REFUND,
  Permission.CASH_SHIFT_MANAGE,
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
  authStrength?: AuthStrength;
  /** True when step-up password elevation is still valid. */
  elevated?: boolean;
  workSessionActive?: boolean;
  workstationLocked?: boolean;
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
  pinEnabled?: boolean;
  pinStatus?: PinStatus;
  pinUpdatedAt?: string | null;
  pinLockedUntil?: string | null;
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
  /** Plaintext PIN returned only once on generate/reset. */
  pinPlaintext?: string;
  workSession?: WorkSessionStatusDto;
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
  STOCK_RESERVATIONS_PREEMPTED = 'STOCK_RESERVATIONS_PREEMPTED',
  BOUQUET_ASSEMBLED = 'BOUQUET_ASSEMBLED',
  BOUQUET_DISASSEMBLED = 'BOUQUET_DISASSEMBLED',
  BOUQUET_ADJUSTED = 'BOUQUET_ADJUSTED',
  BOUQUET_ISSUED = 'BOUQUET_ISSUED',
  BOUQUET_WRITTEN_OFF = 'BOUQUET_WRITTEN_OFF',
  BOUQUET_LINKED_TO_ORDER = 'BOUQUET_LINKED_TO_ORDER',
  ORDER_DIRECT_ISSUED = 'ORDER_DIRECT_ISSUED',
  RESERVE_OVERRIDE_USED = 'RESERVE_OVERRIDE_USED',

  POS_CART_CREATED = 'POS_CART_CREATED',
  POS_CART_UPDATED = 'POS_CART_UPDATED',
  POS_CART_PARKED = 'POS_CART_PARKED',
  POS_CART_RESUMED = 'POS_CART_RESUMED',
  POS_CART_CONFIRMED = 'POS_CART_CONFIRMED',
  POS_PRICE_OVERRIDDEN = 'POS_PRICE_OVERRIDDEN',
  POS_QUICK_SALE_COMPLETED = 'POS_QUICK_SALE_COMPLETED',

  PAYMENT_CREATED = 'PAYMENT_CREATED',
  PAYMENT_CONFIRMED = 'PAYMENT_CONFIRMED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  PAYMENT_CANCELLED = 'PAYMENT_CANCELLED',
  PAYMENT_REFUND_CREATED = 'PAYMENT_REFUND_CREATED',

  CASH_SHIFT_OPENED = 'CASH_SHIFT_OPENED',
  CASH_SHIFT_CLOSED = 'CASH_SHIFT_CLOSED',
  CASH_MOVEMENT_CREATED = 'CASH_MOVEMENT_CREATED',

  PIN_ENABLED = 'PIN_ENABLED',
  PIN_DISABLED = 'PIN_DISABLED',
  PIN_GENERATED = 'PIN_GENERATED',
  PIN_RESET = 'PIN_RESET',
  PIN_UNLOCK_SUCCESS = 'PIN_UNLOCK_SUCCESS',
  PIN_UNLOCK_FAILED = 'PIN_UNLOCK_FAILED',
  PIN_SESSIONS_REVOKED = 'PIN_SESSIONS_REVOKED',

  DEVICE_TRUSTED = 'DEVICE_TRUSTED',
  DEVICE_REVOKED = 'DEVICE_REVOKED',
  DEVICE_UPDATED = 'DEVICE_UPDATED',
  DEVICE_EXTENDED = 'DEVICE_EXTENDED',
  DEVICE_FORCE_LOCKED = 'DEVICE_FORCE_LOCKED',

  WORK_SESSION_OPENED = 'WORK_SESSION_OPENED',
  WORK_SESSION_CLOSED = 'WORK_SESSION_CLOSED',
  WORKSTATION_LOCKED = 'WORKSTATION_LOCKED',
  WORKSTATION_UNLOCKED = 'WORKSTATION_UNLOCKED',
  EMPLOYEE_SWITCHED = 'EMPLOYEE_SWITCHED',

  SECURITY_POLICY_UPDATED = 'SECURITY_POLICY_UPDATED',
  STEP_UP_VERIFIED = 'STEP_UP_VERIFIED',
}

export const SECURITY_POLICY_DEFAULTS = {
  pinEnabledOrg: true,
  deviceTrustDays: 30,
  workSessionMaxHours: 12,
  idleLockMinutes: 5,
  pinMaxAttempts: 5,
  pinLockoutMinutes: 15,
  allowEmployeeSwitch: true,
  requirePasswordForWorkSession: true,
  pinLength: PIN_LENGTH,
} as const;

export const SECURITY_POLICY_LIMITS = {
  deviceTrustDays: { min: 1, max: 90 },
  workSessionMaxHours: { min: 1, max: 24 },
  idleLockMinutes: { min: 1, max: 60 },
  pinMaxAttempts: { min: 3, max: 10 },
  pinLockoutMinutes: { min: 5, max: 60 },
} as const;

export interface SecurityPolicyDto {
  pinEnabledOrg: boolean;
  deviceTrustDays: number;
  workSessionMaxHours: number;
  idleLockMinutes: number;
  pinMaxAttempts: number;
  pinLockoutMinutes: number;
  allowEmployeeSwitch: boolean;
  requirePasswordForWorkSession: boolean;
  pinLength: number;
  updatedAt: string;
}

export interface TrustedDeviceDto {
  id: string;
  name: string;
  accessMode: DeviceAccessMode;
  allowedUserIds: string[];
  createdByUserId: string;
  createdByName: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
  isCurrentDevice?: boolean;
}

export interface WorkSessionStatusDto {
  active: boolean;
  workSessionId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  expiresAt: string | null;
  locked: boolean;
  idleLockMinutes: number;
  allowEmployeeSwitch: boolean;
  authStrength: AuthStrength | null;
  elevated: boolean;
}

export interface PinCandidateDto {
  id: string;
  name: string;
  role: Role;
}

export interface EmployeePinStatusDto {
  pinEnabled: boolean;
  pinStatus: PinStatus;
  pinUpdatedAt: string | null;
  pinLockedUntil: string | null;
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

/** Controlled vocabulary kinds for FLOWER product characteristics. */
export enum ProductAttrKind {
  FLOWER_KIND = 'FLOWER_KIND',
  FLOWER_FORM = 'FLOWER_FORM',
  VARIETY = 'VARIETY',
  COLOR = 'COLOR',
  ORIGIN = 'ORIGIN',
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
  ASSEMBLE = 'ASSEMBLE',
  DISASSEMBLE_RETURN = 'DISASSEMBLE_RETURN',
  DISASSEMBLE_DAMAGE = 'DISASSEMBLE_DAMAGE',
  ISSUE = 'ISSUE',
  DIRECT_ISSUE = 'DIRECT_ISSUE',
}

export enum AssembledBouquetStatus {
  ASSEMBLED = 'ASSEMBLED',
  DISASSEMBLED = 'DISASSEMBLED',
  ISSUED = 'ISSUED',
  WRITTEN_OFF = 'WRITTEN_OFF',
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

export const PRODUCT_ATTR_KIND_LABELS_RU: Record<ProductAttrKind, string> = {
  [ProductAttrKind.FLOWER_KIND]: 'Вид',
  [ProductAttrKind.FLOWER_FORM]: 'Форма / тип',
  [ProductAttrKind.VARIETY]: 'Сорт',
  [ProductAttrKind.COLOR]: 'Цвет',
  [ProductAttrKind.ORIGIN]: 'Происхождение',
};

export const UNIT_LABELS_RU: Record<Unit, string> = {
  [Unit.PIECE]: 'шт.',
};

/** Normalize attribute label for uniqueness (trim, collapse spaces, casefold). */
export function normalizeProductAttrName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

/**
 * Suggest a display name from flower characteristics.
 * Example: «Роза Мондиаль белая 50 см». Does not overwrite existing names.
 */
export function suggestFlowerProductName(parts: {
  kindName?: string | null;
  formName?: string | null;
  varietyName?: string | null;
  colorName?: string | null;
  stemLengthCm?: number | null;
}): string {
  const chunks: string[] = [];
  const kind = parts.kindName?.trim();
  const form = parts.formName?.trim();
  const variety = parts.varietyName?.trim();
  const color = parts.colorName?.trim();
  const stem =
    parts.stemLengthCm != null && Number.isFinite(parts.stemLengthCm) && parts.stemLengthCm > 0
      ? `${Math.round(parts.stemLengthCm)} см`
      : null;

  if (kind) chunks.push(kind);
  if (form) chunks.push(form);
  if (variety) chunks.push(variety);
  if (color) chunks.push(color);
  if (stem) chunks.push(stem);
  return chunks.join(' ').trim();
}

export const STOCK_MOVEMENT_TYPE_LABELS_RU: Record<StockMovementType, string> = {
  [StockMovementType.SUPPLY]: 'Поставка',
  [StockMovementType.SUPPLY_REVERSAL]: 'Отмена поставки',
  [StockMovementType.SALE]: 'Продажа',
  [StockMovementType.WRITE_OFF]: 'Списание',
  [StockMovementType.MANUAL_WRITE_OFF]: 'Списание',
  [StockMovementType.RETURN]: 'Возврат',
  [StockMovementType.INVENTORY_ADJUSTMENT]: 'Инвентаризация',
  [StockMovementType.MANUAL_ADJUSTMENT]: 'Ручная корректировка',
  [StockMovementType.ASSEMBLE]: 'Сборка букета',
  [StockMovementType.DISASSEMBLE_RETURN]: 'Возврат из букета',
  [StockMovementType.DISASSEMBLE_DAMAGE]: 'Списание при разборе',
  [StockMovementType.ISSUE]: 'Выдача букета',
  [StockMovementType.DIRECT_ISSUE]: 'Прямая выдача',
};

export const ASSEMBLED_BOUQUET_STATUS_LABELS_RU: Record<AssembledBouquetStatus, string> = {
  [AssembledBouquetStatus.ASSEMBLED]: 'Собран',
  [AssembledBouquetStatus.DISASSEMBLED]: 'Расформирован',
  [AssembledBouquetStatus.ISSUED]: 'Выдан',
  [AssembledBouquetStatus.WRITTEN_OFF]: 'Списан',
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
  /** Unassembled physical (= available + planned reserve). */
  quantityOnHand: number;
  quantityReserved: number;
  availableQuantity: number;
  /** Inside ASSEMBLED physical bouquets. */
  quantityInBouquets: number;
  /** quantityOnHand + quantityInBouquets. */
  totalPhysical: number;
}

export interface ProductAttributeValueDto {
  id: string;
  kind: ProductAttrKind;
  name: string;
  parentId: string | null;
  parentKey: string;
}

/** Create-or-get reference: existing id and/or draft name resolved on product save. */
export interface ProductAttrRefInput {
  id?: string | null;
  name?: string | null;
}

export interface ProductImageDto {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  /** Authenticated image URL (full). */
  url: string;
  /** Authenticated thumbnail URL. */
  thumbUrl: string;
  isPrimary: boolean;
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
  /** FLOWER-only; null/omitted for SERVICE. */
  flowerKindId?: string | null;
  flowerFormId?: string | null;
  varietyId?: string | null;
  colorId?: string | null;
  originId?: string | null;
  stemLengthCm?: number | null;
  flowerKind?: ProductAttributeValueDto | null;
  flowerForm?: ProductAttributeValueDto | null;
  variety?: ProductAttributeValueDto | null;
  color?: ProductAttributeValueDto | null;
  origin?: ProductAttributeValueDto | null;
  primaryImageId?: string | null;
  images?: ProductImageDto[];
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
  /** ISO date YYYY-MM-DD; null = unknown expiry (conservative shelf policy applies). */
  usableUntil: string | null;
}

/**
 * When StockLot.usableUntil is null, treat the lot as usable only for this many
 * calendar days after receipt (inclusive of receipt day). Prevents promising
 * undated flowers to far-future orders. Not written to DB — evaluation only.
 */
export const UNKNOWN_LOT_SHELF_DAYS = 3;

/** Add calendar days to a YYYY-MM-DD (UTC date arithmetic). */
export function addCalendarDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Effective last usable calendar date for promising / suitability checks.
 * Explicit usableUntil wins; null → receivedAt date + UNKNOWN_LOT_SHELF_DAYS.
 */
export function effectiveUsableUntilIso(
  usableUntil: string | null | undefined,
  receivedAtIsoDate: string,
): string {
  if (usableUntil && /^\d{4}-\d{2}-\d{2}$/.test(usableUntil)) return usableUntil;
  return addCalendarDaysIso(receivedAtIsoDate.slice(0, 10), UNKNOWN_LOT_SHELF_DAYS);
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
  IN_PROGRESS = 'IN_PROGRESS',
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

export enum OrderSource {
  BACKOFFICE = 'BACKOFFICE',
  POS = 'POS',
}

export enum OrderFulfillmentMode {
  WALK_IN = 'WALK_IN',
  SCHEDULED = 'SCHEDULED',
}

export enum OrderPaymentStatus {
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD_TERMINAL = 'CARD_TERMINAL',
  ERIP = 'ERIP',
  ONLINE_CARD = 'ONLINE_CARD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  GIFT_CERTIFICATE = 'GIFT_CERTIFICATE',
}

export enum PaymentSource {
  POS = 'POS',
  BACKOFFICE = 'BACKOFFICE',
  WEBSITE = 'WEBSITE',
  EXTERNAL_INTEGRATION = 'EXTERNAL_INTEGRATION',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

export enum PaymentKind {
  CHARGE = 'CHARGE',
  REFUND = 'REFUND',
}

export enum CashShiftStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum CashMovementType {
  SALE_IN = 'SALE_IN',
  REFUND_OUT = 'REFUND_OUT',
  FLOAT_IN = 'FLOAT_IN',
  FLOAT_OUT = 'FLOAT_OUT',
  ADJUSTMENT = 'ADJUSTMENT',
}

export const ORDER_PAYMENT_STATUS_LABELS_RU: Record<OrderPaymentStatus, string> = {
  [OrderPaymentStatus.UNPAID]: 'Не оплачен',
  [OrderPaymentStatus.PARTIALLY_PAID]: 'Частично оплачен',
  [OrderPaymentStatus.PAID]: 'Оплачен',
  [OrderPaymentStatus.REFUNDED]: 'Возвращён',
  [OrderPaymentStatus.PARTIALLY_REFUNDED]: 'Частичный возврат',
};

export const PAYMENT_METHOD_LABELS_RU: Record<PaymentMethod, string> = {
  [PaymentMethod.CASH]: 'Наличные',
  [PaymentMethod.CARD_TERMINAL]: 'Карта (терминал)',
  [PaymentMethod.ERIP]: 'ЕРИП',
  [PaymentMethod.ONLINE_CARD]: 'Онлайн-карта',
  [PaymentMethod.BANK_TRANSFER]: 'Банковский перевод',
  [PaymentMethod.GIFT_CERTIFICATE]: 'Подарочный сертификат',
};

export enum PosCartStatus {
  OPEN = 'OPEN',
  PARKED = 'PARKED',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

export enum PosCartLineType {
  PRODUCT = 'PRODUCT',
  SERVICE = 'SERVICE',
  BOUQUET_TEMPLATE = 'BOUQUET_TEMPLATE',
  BOUQUET_CUSTOM = 'BOUQUET_CUSTOM',
  ASSEMBLED = 'ASSEMBLED',
}

export enum PosPriceMode {
  ADDITIONAL = 'ADDITIONAL',
  INCLUDED = 'INCLUDED',
}

export const ORDER_SOURCE_LABELS_RU: Record<OrderSource, string> = {
  [OrderSource.BACKOFFICE]: 'Заказы',
  [OrderSource.POS]: 'Продажи',
};

export const ORDER_FULFILLMENT_MODE_LABELS_RU: Record<OrderFulfillmentMode, string> = {
  [OrderFulfillmentMode.WALK_IN]: 'В магазине',
  [OrderFulfillmentMode.SCHEDULED]: 'Предзаказ',
};

export const POS_CART_STATUS_LABELS_RU: Record<PosCartStatus, string> = {
  [PosCartStatus.OPEN]: 'Открыта',
  [PosCartStatus.PARKED]: 'Отложена',
  [PosCartStatus.CONFIRMED]: 'Оформлена',
  [PosCartStatus.CANCELLED]: 'Отменена',
};

export const POS_CART_LINE_TYPE_LABELS_RU: Record<PosCartLineType, string> = {
  [PosCartLineType.PRODUCT]: 'Товар',
  [PosCartLineType.SERVICE]: 'Услуга',
  [PosCartLineType.BOUQUET_TEMPLATE]: 'Букет (шаблон)',
  [PosCartLineType.BOUQUET_CUSTOM]: 'Индивидуальный букет',
  [PosCartLineType.ASSEMBLED]: 'Готовый букет',
};

export const POS_PRICE_MODE_LABELS_RU: Record<PosPriceMode, string> = {
  [PosPriceMode.ADDITIONAL]: 'Дополнительно',
  [PosPriceMode.INCLUDED]: 'Включено в цену',
};

export const ORDER_STATUS_LABELS_RU: Record<OrderStatus, string> = {
  [OrderStatus.NEW]: 'Новый',
  [OrderStatus.IN_PROGRESS]: 'В сборке',
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
  if (status === OrderStatus.IN_PROGRESS) {
    return 'В сборке';
  }
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
  priceMode: PosPriceMode;
  unitSalePriceSnapshot: MoneyString | null;
  sortOrder: number;
}

export interface OrderItemDto {
  id: string;
  itemType: OrderItemType;
  productId: string | null;
  bouquetId: string | null;
  parentOrderItemId: string | null;
  priceMode: PosPriceMode;
  nameSnapshot: string;
  quantity: number;
  quantityIssued: number;
  /** Count of physical AssembledBouquet still ASSEMBLED for this line. */
  quantityAssembled: number;
  recommendedUnitPrice: MoneyString | null;
  unitPrice: MoneyString;
  priceOverridden: boolean;
  lineDiscountType: DiscountType | null;
  lineDiscountValue: MoneyString | null;
  lineDiscountAmount: MoneyString;
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
  source: OrderSource;
  fulfillmentMode: OrderFulfillmentMode;
  paymentStatus: OrderPaymentStatus;
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
  inProgressAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  items: OrderItemDto[];
  requirements: OrderRequirementDto[];
  /** Physical ASSEMBLED bouquets linked to this order. */
  assembledBouquets: AssembledBouquetListItem[];
  paymentSummary: OrderPaymentSummaryDto;
  payments: PaymentDto[];
  fulfillmentProgress: OrderFulfillmentProgressDto;
}

export interface BusinessTimeInfo {
  timeZone: string;
  businessDate: string;
  nowIso: string;
}

export interface WarehouseStockRowDto {
  productId: string;
  productName: string;
  availableQuantity: number;
  reservedQuantity: number;
  quantityInBouquets: number;
  totalPhysical: number;
  deficitQuantity: number;
}

export interface WarehouseStockReserveLineDto {
  orderId: string;
  orderNumber: string;
  fulfillmentDate: string;
  fulfillmentTimeFrom: string | null;
  requiredQuantity: number;
  reservedQuantity: number;
  shortageQuantity: number;
}

export interface WarehouseStockBouquetLineDto {
  assembledBouquetId: string;
  number: string;
  orderId: string | null;
  orderNumber: string | null;
  quantity: number;
  assembledAt: string;
  status: AssembledBouquetStatus;
  nameSnapshot: string;
}

export interface WarehouseStockLotLineDto {
  stockLotId: string;
  remainingQuantity: number;
  unitPurchasePrice: MoneyString | null;
  receivedAt: string;
  usableUntil: string | null;
}

export interface WarehouseStockDetailDto {
  productId: string;
  productName: string;
  availableQuantity: number;
  reservedQuantity: number;
  quantityInBouquets: number;
  totalPhysical: number;
  deficitQuantity: number;
  reserves: WarehouseStockReserveLineDto[];
  bouquets: WarehouseStockBouquetLineDto[];
  freeLots: WarehouseStockLotLineDto[];
}

export interface AssembledBouquetComponentLotDto {
  stockLotId: string;
  quantity: number;
  remainingQuantity: number;
  unitPurchasePrice: MoneyString | null;
}

export interface AssembledBouquetComponentDto {
  id: string;
  productId: string;
  productNameSnapshot: string;
  quantity: number;
  sortOrder: number;
  lots: AssembledBouquetComponentLotDto[];
}

export interface AssembledBouquetListItem {
  id: string;
  number: string;
  status: AssembledBouquetStatus;
  orderId: string | null;
  orderNumber: string | null;
  orderItemId: string | null;
  bouquetTemplateId: string | null;
  nameSnapshot: string;
  version: number;
  unitCost: MoneyString | null;
  hasUncostedComponents: boolean;
  assembledAt: string;
  assembledByName: string;
}

export interface AssembledBouquetDetail extends AssembledBouquetListItem {
  disassembleReason: string | null;
  writeOffReason: string | null;
  issuedAt: string | null;
  disassembledAt: string | null;
  components: AssembledBouquetComponentDto[];
}

export interface PosCartLineComponentDto {
  id: string;
  productId: string;
  productNameSnapshot: string;
  productTypeSnapshot: ProductType;
  unitSnapshot: Unit;
  quantity: number;
  unitSalePriceSnapshot: MoneyString | null;
  priceMode: PosPriceMode;
  /** FLOWER available (onHand − reserved). Null for SERVICE. */
  availableQuantity: number | null;
  sortOrder: number;
}

export interface PosCartLineDto {
  id: string;
  lineType: PosCartLineType;
  productId: string | null;
  bouquetTemplateId: string | null;
  assembledBouquetId: string | null;
  parentLineId: string | null;
  priceMode: PosPriceMode;
  nameSnapshot: string;
  quantity: number;
  recommendedUnitPrice: MoneyString;
  unitPrice: MoneyString;
  priceOverridden: boolean;
  priceOverrideReason: string | null;
  lineDiscountType: DiscountType | null;
  lineDiscountValue: MoneyString | null;
  lineDiscountAmount: MoneyString;
  lineSubtotal: MoneyString;
  sortOrder: number;
  components: PosCartLineComponentDto[];
  childLines: PosCartLineDto[];
}

export interface PosCartDto {
  id: string;
  status: PosCartStatus;
  ownerUserId: string;
  version: number;
  discountType: DiscountType | null;
  discountValue: MoneyString | null;
  discountAmount: MoneyString;
  subtotal: MoneyString;
  total: MoneyString;
  parkedAt: string | null;
  parkedLabel: string | null;
  confirmedOrderId: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PosCartLineDto[];
}

export interface PosCartListItem {
  id: string;
  status: PosCartStatus;
  ownerUserId: string;
  version: number;
  total: MoneyString;
  lineCount: number;
  parkedAt: string | null;
  parkedLabel: string | null;
  updatedAt: string;
}

export interface PosCatalogItemDto {
  kind: 'PRODUCT' | 'SERVICE' | 'BOUQUET' | 'ASSEMBLED';
  id: string;
  name: string;
  salePrice: MoneyString | null;
  productType: ProductType | null;
  availableQuantity: number | null;
  assembledNumber: string | null;
  assembledStatus: AssembledBouquetStatus | null;
  primaryImageId: string | null;
}

export interface OrderPaymentSummaryDto {
  orderTotal: MoneyString;
  confirmedPaid: MoneyString;
  confirmedRefunded: MoneyString;
  netPaid: MoneyString;
  pendingAmount: MoneyString;
  remainingDue: MoneyString;
  paymentProgressPercent: number;
  paymentStatus: OrderPaymentStatus;
}

export interface PaymentDto {
  id: string;
  orderId: string;
  kind: PaymentKind;
  amount: MoneyString;
  currency: string;
  method: PaymentMethod;
  source: PaymentSource;
  status: PaymentStatus;
  parentPaymentId: string | null;
  externalTransactionId: string | null;
  externalProvider: string | null;
  idempotencyKey: string;
  cashShiftId: string | null;
  isManual: boolean;
  note: string | null;
  createdByUserId: string;
  createdByName: string;
  confirmedByUserId: string | null;
  confirmedByName: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface OrderFulfillmentProgressDto {
  fulfillmentType: FulfillmentType;
  fulfillmentMode: OrderFulfillmentMode;
  status: OrderStatus;
  /** Stages for UI strip (id + label + state). */
  stages: Array<{
    id: string;
    label: string;
    state: 'done' | 'current' | 'pending' | 'skipped';
    at: string | null;
    byName: string | null;
    /** Honest annotation, e.g. «Нет подтверждения» for courier stages. */
    hint?: string | null;
  }>;
  bouquetAssembledCount: number;
  bouquetRequiredCount: number;
  productIssuedCount: number;
  productRequiredCount: number;
  nextAction: string | null;
}

export interface CashShiftDto {
  id: string;
  cashRegisterId: string;
  cashRegisterCode: string;
  cashRegisterName: string;
  status: CashShiftStatus;
  openingFloat: MoneyString;
  expectedCash: MoneyString | null;
  countedCash: MoneyString | null;
  discrepancy: MoneyString | null;
  openedAt: string;
  closedAt: string | null;
  openedByName: string;
  closedByName: string | null;
  note: string | null;
}

export interface CashMovementDto {
  id: string;
  cashShiftId: string;
  type: CashMovementType;
  amount: MoneyString;
  paymentId: string | null;
  note: string | null;
  createdByName: string;
  createdAt: string;
}

export interface CashRegisterDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /** OPEN shift on this register, if any. */
  openShift: CashShiftDto | null;
}

export interface CashShiftSummaryDto {
  openingFloat: MoneyString;
  saleIn: MoneyString;
  refundOut: MoneyString;
  floatIn: MoneyString;
  floatOut: MoneyString;
  adjustments: MoneyString;
  /** opening + saleIn − refundOut + floatIn − floatOut + adjustments. */
  expectedCash: MoneyString;
}

export interface CashShiftDetailDto extends CashShiftDto {
  summary: CashShiftSummaryDto;
  movements: CashMovementDto[];
}

export interface PosQuickSellResultDto {
  cart: PosCartDto;
  orderId: string;
  orderNumber: string;
  paymentStatus: OrderPaymentStatus;
  orderStatus: OrderStatus;
  payments: PaymentDto[];
  issued: boolean;
  /** Non-fatal problems (e.g. issue failed on stock) — order stays paid but not completed. */
  warnings: string[];
}

export interface PaymentMutationResultDto {
  payment: PaymentDto;
  summary: OrderPaymentSummaryDto;
  /** True when an idempotent retry returned the already-recorded payment. */
  replayed: boolean;
}

export interface OrderPaymentsDto {
  summary: OrderPaymentSummaryDto;
  payments: PaymentDto[];
}
