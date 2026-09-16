import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';

function emptyToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeMoney(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : value;
  if (typeof value === 'string') return value.trim().replace(',', '.');
  return value;
}

export class SupplyItemInputDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  @ApiProperty({ description: 'Unit purchase price decimal string' })
  @Transform(({ value }) => normalizeMoney(value))
  @IsString()
  @MaxLength(20)
  unitPurchasePrice!: string;
}

export class CreateSupplyDto {
  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  documentDate!: string;

  @ApiProperty({ description: 'Supplier id from suppliers directory' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  supplierId!: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsDateString()
  paymentDueDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;

  @ApiProperty({ type: [SupplyItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SupplyItemInputDto)
  items!: SupplyItemInputDto[];
}

export class UpdateSupplyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  supplierId?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsDateString()
  paymentDueDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @MaxLength(2000)
  comment?: string | null;

  @ApiPropertyOptional({ type: [SupplyItemInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SupplyItemInputDto)
  items?: SupplyItemInputDto[];
}

export class CorrectSupplyDto {
  @ApiProperty()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class CancelSupplyDto {
  @ApiProperty()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class SupplyQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}
