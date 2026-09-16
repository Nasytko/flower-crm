import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BouquetsController } from './bouquets.controller';
import { BouquetsService } from './bouquets.service';

@Module({
  imports: [AuditModule],
  controllers: [BouquetsController],
  providers: [BouquetsService],
  exports: [BouquetsService],
})
export class BouquetsModule {}
