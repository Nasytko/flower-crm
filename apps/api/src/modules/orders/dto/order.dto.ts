import { Type, Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DiscountType,
  FulfillmentType,
  OrderItemType,
  OrderStatus,
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

export class OrderItemInputDto {
  @ApiProperty({ enum: OrderItemType })
  @IsEnum(OrderItemType)
  itemType!: OrderItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  bouquetId?: string | null;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  /** Optional override; requires orders.discount. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  unitPrice?: string | null;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ description: 'Optional; phone is the primary customer field' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @ApiProperty()
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  customerPhone!: string;

  @ApiProperty({ enum: FulfillmentType })
  @IsEnum(FulfillmentType)
  fulfillmentType!: FulfillmentType;

  @ApiProperty({ example: '2026-09-15' })
  @IsDateString()
  fulfillmentDate!: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  orderComment?: string | null;

  @ApiPropertyOptional({ enum: DiscountType })
  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  discountValue?: string | null;

  @ApiProperty({ type: [OrderItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

export class UpdateOrderDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ description: 'Optional; phone is the primary customer field' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional({ enum: FulfillmentType })
  @IsOptional()
  @IsEnum(FulfillmentType)
  fulfillmentType?: FulfillmentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fulfillmentDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(5)
  fulfillmentTimeFrom?: string | null;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  orderComment?: string | null;

  @ApiPropertyOptional({ enum: DiscountType })
  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeMoney)
  @IsString()
  @MaxLength(20)
  discountValue?: string | null;

  @ApiPropertyOptional({ type: [OrderItemInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
}

export class ChangeOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class OrderQueryDto {
  @ApiPropertyOptional({ description: 'Fulfillment date YYYY-MM-DD (required for Kanban)' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: FulfillmentType })
  @IsOptional()
  @IsEnum(FulfillmentType)
  fulfillmentType?: FulfillmentType;

  @ApiPropertyOptional({ description: 'Include CANCELLED in Kanban-style lists', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  includeCancelled?: boolean;

  @ApiPropertyOptional({ description: 'HH:mm inclusive lower bound on timeFrom' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  timeFrom?: string;

  @ApiPropertyOptional({ description: 'HH:mm exclusive upper bound on timeFrom' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  timeTo?: string;

  @ApiPropertyOptional({ description: 'Only orders without fulfillmentTimeFrom' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  withoutTime?: boolean;

  @ApiPropertyOptional({
    description:
      'Search by number, name, phone, address, comment. When set without date — search across all fulfillment dates.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 200;
}
