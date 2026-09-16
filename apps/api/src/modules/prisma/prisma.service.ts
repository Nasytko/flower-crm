import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createPrismaAdapter, PrismaClient } from '@erp/database';
import { AppConfigService } from '../../config/app-config.service';

const DEFAULT_PING_TIMEOUT_MS = 3000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({ adapter: createPrismaAdapter(config.databaseUrl) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS): Promise<boolean> {
    try {
      await Promise.race([
        this.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('database ping timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch (error) {
      this.logger.warn({
        msg: 'PostgreSQL ping failed',
        errName: error instanceof Error ? error.name : 'UnknownError',
      });
      return false;
    }
  }
}
