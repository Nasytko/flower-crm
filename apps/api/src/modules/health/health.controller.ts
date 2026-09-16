import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { HealthResponseDto } from './health.dto';
import { HealthService } from './health.service';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Process liveness (no DB). Suitable for Docker/kube liveness probes. */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Process liveness (does not check PostgreSQL)' })
  @ApiResponse({ status: 200, description: 'API process is up' })
  getLive(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: API + PostgreSQL. Docker healthcheck should use this. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Check API process and PostgreSQL availability' })
  @ApiResponse({
    status: 200,
    type: HealthResponseDto,
    description: 'API and database are healthy',
  })
  @ApiResponse({
    status: 503,
    type: HealthResponseDto,
    description: 'API is running but the database is unavailable',
  })
  async getHealth(@Res({ passthrough: true }) response: Response): Promise<HealthResponseDto> {
    const result = await this.healthService.getHealth();
    response.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
