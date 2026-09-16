import { ApiProperty } from '@nestjs/swagger';
import type { DatabaseStatus, HealthResponse, ServiceStatus } from '@erp/shared';

export class HealthResponseDto implements HealthResponse {
  @ApiProperty({ enum: ['ok', 'degraded'], example: 'ok' })
  status!: ServiceStatus;

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database!: DatabaseStatus;
}
