import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WarehouseLockService } from './warehouse-lock.service';
import { StockFifoService } from './stock-fifo.service';
import { ReservationAllocationService } from './reservation-allocation.service';

@Global()
@Module({
  imports: [AuditModule],
  providers: [WarehouseLockService, StockFifoService, ReservationAllocationService],
  exports: [WarehouseLockService, StockFifoService, ReservationAllocationService],
})
export class WarehouseModule {}
