import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import {
  CreateProductDto,
  ProductQueryDto,
  StockMovementsQueryDto,
  UpdateProductDto,
  WriteOffStockDto,
} from './dto/product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCTS_VIEW)
  @ApiOperation({ summary: 'List products with stock / average purchase cost' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ProductQueryDto) {
    return this.productsService.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCTS_VIEW)
  @ApiOperation({ summary: 'Get product by id' })
  getById(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.productsService.getById(actor, id);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @ApiOperation({ summary: 'Create product (FLOWER gets stock=0 atomically)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateProductDto,
    @Req() request: Request,
  ) {
    return this.productsService.create(actor, dto, this.contextFrom(request));
  }

  @Patch(':id')
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @ApiOperation({ summary: 'Update product (type/unit immutable)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() request: Request,
  ) {
    return this.productsService.update(actor, id, dto, this.contextFrom(request));
  }

  @Post(':id/stock/write-off')
  @RequirePermissions(Permission.INVENTORY_ADJUST)
  @ApiOperation({ summary: 'Manual write-off (FLOWER only, positive qty, FIFO lots)' })
  writeOff(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: WriteOffStockDto,
    @Req() request: Request,
  ) {
    return this.productsService.writeOff(actor, id, dto, this.contextFrom(request));
  }

  @Get(':id/stock/movements')
  @RequirePermissions(Permission.INVENTORY_VIEW)
  @ApiOperation({ summary: 'Stock movement history (FLOWER only)' })
  listMovements(@Param('id') id: string, @Query() query: StockMovementsQueryDto) {
    return this.productsService.listMovements(id, query);
  }

  private contextFrom(request: Request) {
    const requestIdHeader = request.headers[REQUEST_ID_HEADER];
    return {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      requestId: Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader,
    };
  }
}
