import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CashShiftController } from './cash-shift.controller';
import { CashShiftService } from './cash-shift.service';

@Module({
  imports: [AuditModule],
  controllers: [CashShiftController],
  providers: [CashShiftService],
  exports: [CashShiftService],
})
export class CashModule {}
