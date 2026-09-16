import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { OrdersService } from './orders.service';
import {
  ChangeOrderStatusDto,
  CreateOrderDto,
  OrderQueryDto,
  UpdateOrderDto,
} from './dto/order.dto';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('business-time')
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'Authoritative business timezone/date for Orders UI' })
  businessTime() {
    return this.orders.businessTime();
  }

  @Get()
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'List orders for a fulfillment date (Kanban)' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: OrderQueryDto) {
    return this.orders.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'Order detail' })
  getById(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.getById(actor, id);
  }

  @Post()
  @RequirePermissions(Permission.ORDERS_CREATE)
  @ApiOperation({
    summary: 'Create order (reserves FLOWER stock when available; shortage allowed)',
  })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
    @Req() request: Request,
  ) {
    return this.orders.create(actor, dto, this.contextFrom(request));
  }

  @Patch(':id')
  @RequirePermissions(Permission.ORDERS_UPDATE)
  @ApiOperation({ summary: 'Update NEW order (CAS + full item replace)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @Req() request: Request,
  ) {
    return this.orders.update(actor, id, dto, this.contextFrom(request));
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDERS_STATUS)
  @ApiOperation({
    summary: 'Transition order status (ORDERS_CANCEL also required for CANCELLED)',
  })
  changeStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeOrderStatusDto,
    @Req() request: Request,
  ) {
    return this.orders.changeStatus(actor, id, dto, this.contextFrom(request));
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
