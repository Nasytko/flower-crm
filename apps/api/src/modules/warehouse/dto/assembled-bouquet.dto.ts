import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AssembleComponentDto {
  @IsString()
  productId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class AssembleBouquetDto {
  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  orderItemId?: string;

  @IsOptional()
  @IsString()
  bouquetTemplateId?: string;

  @IsString()
  @MinLength(1)
  nameSnapshot!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AssembleComponentDto)
  components!: AssembleComponentDto[];

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsBoolean()
  allowReserveOverride?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedOrderVersion?: number;
}

export class DisassembleLineDto {
  @IsString()
  productId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  returnQuantity!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  damageQuantity!: number;
}

export class DisassembleBouquetDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DisassembleLineDto)
  lines!: DisassembleLineDto[];
}

export class AdjustComponentDto {
  @IsString()
  productId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantity!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  damageQuantity?: number;
}

export class AdjustBouquetDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdjustComponentDto)
  components!: AdjustComponentDto[];

  @IsOptional()
  @IsBoolean()
  allowReserveOverride?: boolean;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class IssueBouquetDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class WriteOffBouquetDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(1)
  reason!: string;
}

export class LinkBouquetDto {
  @IsString()
  orderId!: string;

  @IsOptional()
  @IsString()
  orderItemId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class DirectIssueDto {
  @IsString()
  orderItemId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedOrderVersion!: number;
}
