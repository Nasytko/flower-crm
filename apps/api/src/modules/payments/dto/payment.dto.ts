import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentSource } from '@erp/shared';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeMoney({ value }: { value: unknown }): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === 'string') return value.trim().replace(',', '.');
  return value;
}

const MONEY = /^\d+(\.\d{1,2})?$/;

export class CreatePaymentDto {
  @ApiProperty({ example: '25.00' })
  @Transform(normalizeMoney)
  @Matches(MONEY, { message: 'amount должен быть суммой вида 0.00' })
  amount!: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({ minLength: 8 })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiPropertyOptional({ enum: [PaymentSource.POS, PaymentSource.BACKOFFICE] })
  @IsOptional()
  @IsIn([PaymentSource.POS, PaymentSource.BACKOFFICE])
  source?: PaymentSource;

  @ApiPropertyOptional({
    description: 'Provider code, e.g. ERIP / bepaid (required with externalTransactionId)',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(64)
  externalProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(128)
  externalTransactionId?: string;

  @ApiPropertyOptional({
    description:
      'Non-cash only: record as CONFIRMED right away. Requires isManual=true and payments.confirm.',
  })
  @IsOptional()
  @IsBoolean()
  confirmImmediately?: boolean;

  @ApiPropertyOptional({ description: 'Staff recorded the payment manually (no provider webhook)' })
  @IsOptional()
  @IsBoolean()
  isManual?: boolean;

  @ApiPropertyOptional({
    description: 'CASH only. Defaults to the open shift of the MAIN register.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cashShiftId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ConfirmPaymentDto {
  @ApiProperty({
    description: 'Must be true: confirmation is a manual staff action (no provider webhook yet)',
  })
  @IsBoolean()
  isManual!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(64)
  externalProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(128)
  externalTransactionId?: string;

  @ApiPropertyOptional({ description: 'CASH only' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cashShiftId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RefundPaymentDto {
  @ApiPropertyOptional({ description: 'Defaults to the full refundable remainder of the payment' })
  @IsOptional()
  @Transform(normalizeMoney)
  @Matches(MONEY, { message: 'amount должен быть суммой вида 0.00' })
  amount?: string;

  @ApiProperty({ minLength: 8 })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'CASH refunds only' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cashShiftId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelPaymentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;
}
