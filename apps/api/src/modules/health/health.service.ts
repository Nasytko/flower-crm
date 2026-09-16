import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@erp/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async getHealth(): Promise<HealthResponse> {
    const databaseUp = await this.prisma.ping();

    if (databaseUp) {
      return { status: 'ok', database: 'up' };
    }

    return { status: 'degraded', database: 'down' };
  }
}
