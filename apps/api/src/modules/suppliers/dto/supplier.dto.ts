import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

function emptyToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class SupplierQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'true | false | all', default: 'true' })
  @IsOptional()
  @IsString()
  isActive?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class CreateSupplierDto {
  @ApiProperty()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  comment?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
