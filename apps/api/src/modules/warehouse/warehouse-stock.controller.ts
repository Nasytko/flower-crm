import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { WarehouseStockService } from './warehouse-stock.service';

@ApiTags('warehouse')
@ApiBearerAuth()
@Controller('warehouse')
export class WarehouseStockController {
  constructor(private readonly stock: WarehouseStockService) {}

  @Get('stock')
  @RequirePermissions(Permission.PRODUCTS_VIEW)
  @ApiOperation({
    summary: 'Three-bucket stock rows: available / reserve / in bouquets / total / deficit',
  })
  list() {
    return this.stock.listStockRows();
  }

  @Get('stock/:productId')
  @RequirePermissions(Permission.PRODUCTS_VIEW)
  @ApiOperation({ summary: 'Stock drill-down: reserves, bouquets, free lots' })
  async detail(@Param('productId') productId: string) {
    const row = await this.stock.getStockDetail(productId);
    if (!row) throw new NotFoundException('Товар не найден');
    return row;
  }
}
