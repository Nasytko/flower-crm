import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DiscountType,
  FulfillmentType,
  OrderFulfillmentMode,
  PaymentMethod,
  PosCartLineType,
  PosCartStatus,
  PosPriceMode,
} from '@erp/shared';

function emptyToNull({ value }: { value: unknown }): unknown {
  if (value === '' || value === undefined) return null;
  return value;
}

function trimString({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  return value.trim();
}

function normalizeMoney({ value }: { value: unknown }): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === 'string') {
    return value.trim().replace(',', '.');
  }
  return value;
}

export class PosCartComponentInputDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;

  /** SERVICE only: INCLUDED (default for template services) vs ADDITIONAL. */
  @ApiPropertyOptional({ enum: PosPriceMode })
  @IsOptional()
  @IsEnum(PosPriceMode)
  priceMode?: PosPriceMode;
}

export class AddPosCartLineDto {
  @ApiPropertyOptional({ description: 'Cart version for CAS; optional for add' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @ApiProperty({ enum: PosCartLineType })
  @IsEnum(PosCartLineType)
  lineType!: PosCartLineType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  bouquetTemplateId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assembledBouquetId?: string;

  /** Attach a SERVICE line to a specific bouquet/product line of this cart. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentLineId?: string;

  /** PRODUCT/SERVICE quantity. Bouquet / assembled instances are always 1. */
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;

  @ApiPropertyOptional({ description: 'Display name for BOUQUET_CUSTOM' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  nameSnapshot?: string;

  @ApiPropertyOptional({
    type: [PosCartComponentInputDto],
    description: 'Required for BOUQUET_CUSTOM; overrides template composition for BOUQUET_TEMPLATE',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PosCartComponentInputDto)
  components?: PosCartComponentInputDto[];

  /** Price override; requires pos.price_override or orders.discount. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  unitPrice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  priceOverrideReason?: string;

  @ApiPropertyOptional({ enum: PosPriceMode })
  @IsOptional()
  @IsEnum(PosPriceMode)
  priceMode?: PosPriceMode;

  /** BOUQUET_TEMPLATE: create N independent bouquet instances (qty=1 each). */
  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  copies?: number;
}

export class UpdatePosCartLineDto {
  @ApiProperty({ description: 'Cart version' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameSnapshot?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  unitPrice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  priceOverrideReason?: string | null;

  @ApiPropertyOptional({ enum: PosPriceMode })
  @IsOptional()
  @IsEnum(PosPriceMode)
  priceMode?: PosPriceMode;

  /** null clears the line discount. */
  @ApiPropertyOptional({ enum: DiscountType, nullable: true })
  @IsOptional()
  @IsEnum(DiscountType)
  lineDiscountType?: DiscountType | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  lineDiscountValue?: string | null;

  /** Replace composition for bouquet lines. */
  @ApiPropertyOptional({ type: [PosCartComponentInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PosCartComponentInputDto)
  components?: PosCartComponentInputDto[];

  /** Reset unitPrice to the (re)calculated recommended price and clear the override flag. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  acceptRecommendedPrice?: boolean;
}

export class RemovePosCartLineQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class UpdatePosCartDiscountDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  /** null clears the cart discount. */
  @ApiPropertyOptional({ enum: DiscountType, nullable: true })
  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  discountValue?: string | null;
}

export class ParkPosCartDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  parkedLabel?: string | null;
}

export class ResumePosCartDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ListPosCartsQueryDto {
  @ApiPropertyOptional({ enum: [PosCartStatus.OPEN, PosCartStatus.PARKED] })
  @IsOptional()
  @IsEnum(PosCartStatus)
  status?: PosCartStatus;
}

export class ConfirmPosCartDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ minLength: 8 })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiProperty({ enum: OrderFulfillmentMode })
  @IsEnum(OrderFulfillmentMode)
  fulfillmentMode!: OrderFulfillmentMode;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  customerName?: string;

  /** Required (min 3) for SCHEDULED; optional for WALK_IN. */
  @ApiPropertyOptional()
  @ValidateIf(
    (o: ConfirmPosCartDto) =>
      o.fulfillmentMode === OrderFulfillmentMode.SCHEDULED ||
      (o.customerPhone !== undefined && o.customerPhone !== null && o.customerPhone !== ''),
  )
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional({ enum: FulfillmentType })
  @IsOptional()
  @IsEnum(FulfillmentType)
  fulfillmentType?: FulfillmentType;

  /** Required for SCHEDULED (YYYY-MM-DD). */
  @ApiPropertyOptional({ example: '2026-09-15' })
  @ValidateIf((o: ConfirmPosCartDto) => o.fulfillmentMode === OrderFulfillmentMode.SCHEDULED)
  @IsDateString()
  fulfillmentDate?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(5)
  fulfillmentTimeFrom?: string | null;

  @ApiPropertyOptional({ example: '20:00' })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(5)
  fulfillmentTimeTo?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  orderComment?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  recipientName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(32)
  recipientPhone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  deliveryAddressText?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLatitude?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLongitude?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(64)
  deliveryProvider?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(128)
  deliveryProviderPlaceId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  deliveryComment?: string | null;
}

export class PosCatalogQueryDto {
  @ApiPropertyOptional({ description: 'Name search (min 1 char). Empty returns nothing.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class QuickSellPaymentDto {
  @ApiProperty({ enum: [PaymentMethod.CASH, PaymentMethod.CARD_TERMINAL] })
  @IsIn([PaymentMethod.CASH, PaymentMethod.CARD_TERMINAL])
  method!: PaymentMethod;

  @ApiProperty({ example: '25.00' })
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  amount!: string;

  @ApiProperty({ minLength: 8 })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;
}

export class QuickSellDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ minLength: 8, description: 'Used as the cart confirm key; retry-safe.' })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiProperty({
    type: [QuickSellPaymentDto],
    description: 'CONFIRMED CASH / CARD_TERMINAL payments',
  })
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => QuickSellPaymentDto)
  payments!: QuickSellPaymentDto[];

  @ApiPropertyOptional({ description: 'Issue goods right after payment (default true)' })
  @IsOptional()
  @IsBoolean()
  issue?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  orderComment?: string;
}
