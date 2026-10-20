import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductAttrKind } from '@erp/shared';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class ProductAttributeQueryDto {
  @ApiProperty({ enum: ProductAttrKind })
  @IsEnum(ProductAttrKind)
  kind!: ProductAttrKind;

  @ApiPropertyOptional({ description: 'Parent flower kind id (for VARIETY / FLOWER_FORM)' })
  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MaxLength(64)
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 100;
}
