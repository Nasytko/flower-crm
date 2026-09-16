import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class AddressSuggestQueryDto {
  @ApiProperty({ description: 'Partial street / address query' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @ApiPropertyOptional({ default: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}
