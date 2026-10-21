import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WarehouseLockService } from './warehouse-lock.service';
import { StockFifoService } from './stock-fifo.service';
import { ReservationAllocationService } from './reservation-allocation.service';
import { StockBalanceService } from './stock-balance.service';
import { AssembledBouquetService } from './assembled-bouquet.service';
import { WarehouseStockService } from './warehouse-stock.service';
import { AssembledBouquetsController } from './assembled-bouquets.controller';
import { WarehouseStockController } from './warehouse-stock.controller';

@Global()
@Module({
  imports: [AuditModule],
  controllers: [AssembledBouquetsController, WarehouseStockController],
  providers: [
    WarehouseLockService,
    StockFifoService,
    ReservationAllocationService,
    StockBalanceService,
    AssembledBouquetService,
    WarehouseStockService,
  ],
  exports: [
    WarehouseLockService,
    StockFifoService,
    ReservationAllocationService,
    StockBalanceService,
    AssembledBouquetService,
    WarehouseStockService,
  ],
})
export class WarehouseModule {}
