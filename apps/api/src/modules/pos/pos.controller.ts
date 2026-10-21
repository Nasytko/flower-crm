import {
  Body,
  Controller,
  Delete,
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
import { PosCartService } from './pos-cart.service';
import { PosCatalogService } from './pos-catalog.service';
import { PosQuickSellService } from './pos-quick-sell.service';
import {
  AddPosCartLineDto,
  ConfirmPosCartDto,
  ListPosCartsQueryDto,
  ParkPosCartDto,
  PosCatalogQueryDto,
  QuickSellDto,
  RemovePosCartLineQueryDto,
  ResumePosCartDto,
  UpdatePosCartDiscountDto,
  UpdatePosCartLineDto,
} from './dto/pos.dto';

@ApiTags('pos')
@ApiBearerAuth()
@Controller('pos')
export class PosController {
  constructor(
    private readonly carts: PosCartService,
    private readonly catalog: PosCatalogService,
    private readonly quickSell: PosQuickSellService,
  ) {}

  @Post('carts')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Create an OPEN POS cart for the current user' })
  createCart(@CurrentUser() actor: AuthenticatedUser, @Req() request: Request) {
    return this.carts.createCart(actor, this.contextFrom(request));
  }

  @Get('carts')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'List own OPEN / PARKED carts' })
  listCarts(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListPosCartsQueryDto) {
    return this.carts.listCarts(actor, query.status);
  }

  @Get('carts/:id')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Cart detail with component availability' })
  getCart(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.carts.getCart(actor, id);
  }

  @Post('carts/:id/lines')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Add line(s) to the cart (no warehouse impact)' })
  addLine(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddPosCartLineDto,
    @Req() request: Request,
  ) {
    return this.carts.addLine(actor, id, dto, this.contextFrom(request));
  }

  @Patch('carts/:id/lines/:lineId')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Update a cart line (CAS on cart version)' })
  updateLine(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdatePosCartLineDto,
    @Req() request: Request,
  ) {
    return this.carts.updateLine(actor, id, lineId, dto, this.contextFrom(request));
  }

  @Delete('carts/:id/lines/:lineId')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Remove a cart line (and its attached child lines)' })
  removeLine(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Query() query: RemovePosCartLineQueryDto,
    @Req() request: Request,
  ) {
    return this.carts.removeLine(
      actor,
      id,
      lineId,
      query.expectedVersion,
      this.contextFrom(request),
    );
  }

  @Patch('carts/:id/discount')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Set / clear cart discount (pos.discount or orders.discount)' })
  updateDiscount(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePosCartDiscountDto,
    @Req() request: Request,
  ) {
    return this.carts.updateDiscount(actor, id, dto, this.contextFrom(request));
  }

  @Post('carts/:id/park')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Park (postpone) an OPEN cart' })
  park(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ParkPosCartDto,
    @Req() request: Request,
  ) {
    return this.carts.park(actor, id, dto, this.contextFrom(request));
  }

  @Post('carts/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Resume a PARKED cart' })
  resume(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResumePosCartDto,
    @Req() request: Request,
  ) {
    return this.carts.resume(actor, id, dto.expectedVersion, this.contextFrom(request));
  }

  @Post('carts/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.POS_SELL)
  @ApiOperation({
    summary: 'Confirm cart → Order (idempotent by idempotencyKey; UNPAID in stage 1)',
  })
  confirm(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmPosCartDto,
    @Req() request: Request,
  ) {
    return this.carts.confirm(actor, id, dto, this.contextFrom(request));
  }

  @Post('carts/:id/quick-sell')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.POS_SELL, Permission.PAYMENTS_CREATE)
  @ApiOperation({
    summary:
      'Pay and issue: confirm cart as WALK_IN, register confirmed CASH/CARD payments, issue goods (retry-safe)',
  })
  quickSellCart(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: QuickSellDto,
    @Req() request: Request,
  ) {
    return this.quickSell.quickSell(actor, id, dto, this.contextFrom(request));
  }

  @Get('catalog/search')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Search products / bouquets / display assembled bouquets (max 40)' })
  search(@Query() query: PosCatalogQueryDto) {
    return this.catalog.search(query.q);
  }

  @Get('catalog/popular')
  @RequirePermissions(Permission.POS_ACCESS)
  @ApiOperation({ summary: 'Quick-pick catalog (recent bouquets + flowers)' })
  popular() {
    return this.catalog.popular();
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
