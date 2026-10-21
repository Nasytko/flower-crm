import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CashMovementType, CashShiftStatus } from '@erp/shared';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeMoney({ value }: { value: unknown }): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === 'string') return value.trim().replace(',', '.');
  return value;
}

const MONEY = /^\d+(\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d+(\.\d{1,2})?$/;

export class OpenCashShiftDto {
  @ApiPropertyOptional({ description: 'Defaults to register with code MAIN' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cashRegisterId?: string;

  @ApiProperty({ example: '100.00' })
  @Transform(normalizeMoney)
  @Matches(MONEY, { message: 'openingFloat должен быть суммой вида 0.00' })
  openingFloat!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CloseCashShiftDto {
  @ApiProperty({ example: '350.00' })
  @Transform(normalizeMoney)
  @Matches(MONEY, { message: 'countedCash должен быть суммой вида 0.00' })
  countedCash!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Reserved. CashShift has no version column; concurrent closes are serialized by a row lock and the second one gets CASH_SHIFT_CLOSED.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class CashMovementInputDto {
  @ApiProperty({
    enum: [CashMovementType.FLOAT_IN, CashMovementType.FLOAT_OUT, CashMovementType.ADJUSTMENT],
  })
  @IsEnum(CashMovementType)
  type!: CashMovementType;

  @ApiProperty({ description: 'Positive for FLOAT_IN/FLOAT_OUT; ADJUSTMENT may be negative' })
  @Transform(normalizeMoney)
  @Matches(SIGNED_MONEY, { message: 'amount должен быть суммой вида 0.00' })
  amount!: string;

  @ApiProperty()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note!: string;
}

export class ListCashShiftsQueryDto {
  @ApiPropertyOptional({ enum: CashShiftStatus })
  @IsOptional()
  @IsEnum(CashShiftStatus)
  status?: CashShiftStatus;
}
