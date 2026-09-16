import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

function emptyToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class CreateInventoryDto {
  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}

export class InventoryQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class UpdateInventoryItemDto {
  @ApiProperty({ description: 'Physical counted quantity (>= 0). Use 0 for empty shelf.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  countedQuantity!: number;
}

export class BatchInventoryItemUpdateDto {
  @ApiProperty()
  @IsString()
  itemId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  countedQuantity!: number;
}

export class BatchUpdateInventoryItemsDto {
  @ApiProperty({ type: [BatchInventoryItemUpdateDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchInventoryItemUpdateDto)
  items!: BatchInventoryItemUpdateDto[];
}

export class CancelInventoryDto {
  @ApiPropertyOptional({ description: 'Required when cancelling IN_PROGRESS' })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason?: string | null;
}
