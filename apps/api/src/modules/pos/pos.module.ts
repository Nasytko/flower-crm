import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CashModule } from '../cash/cash.module';
import { PaymentsModule } from '../payments/payments.module';
import { PosController } from './pos.controller';
import { PosCartService } from './pos-cart.service';
import { PosCatalogService } from './pos-catalog.service';
import { PosQuickSellService } from './pos-quick-sell.service';

@Module({
  imports: [AuditModule, CashModule, PaymentsModule],
  controllers: [PosController],
  providers: [PosCartService, PosCatalogService, PosQuickSellService],
  exports: [PosCartService, PosCatalogService, PosQuickSellService],
})
export class PosModule {}
