import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import {
  BatchUpdateInventoryItemsDto,
  CancelInventoryDto,
  CreateInventoryDto,
  InventoryQueryDto,
  UpdateInventoryItemDto,
} from './dto/inventory.dto';
import { InventoriesService } from './inventories.service';

@ApiTags('inventories')
@ApiBearerAuth()
@Controller('inventories')
export class InventoriesController {
  constructor(private readonly inventoriesService: InventoriesService) {}

  @Get()
  @RequirePermissions(Permission.INVENTORY_VIEW)
  @ApiOperation({ summary: 'List inventory sessions (newest first)' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventoriesService.list(actor, query);
  }

  @Get('active')
  @RequirePermissions(Permission.INVENTORY_VIEW)
  @ApiOperation({ summary: 'Active IN_PROGRESS inventory, if any' })
  async getActive(
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const active = await this.inventoriesService.getActive(actor);
    if (active === null) {
      res.status(200).json(null);
      return;
    }
    return active;
  }

  @Get(':id')
  @RequirePermissions(Permission.INVENTORY_VIEW)
  @ApiOperation({ summary: 'Inventory session detail with items' })
  getById(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.inventoriesService.getById(actor, id);
  }

  @Post()
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({ summary: 'Create inventory DRAFT' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateInventoryDto,
    @Req() request: Request,
  ) {
    return this.inventoriesService.create(actor, dto, this.contextFrom(request));
  }

  @Post('start-new')
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({ summary: 'Create DRAFT and start in one step' })
  createAndStart(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateInventoryDto,
    @Req() request: Request,
  ) {
    return this.inventoriesService.createAndStart(actor, dto, this.contextFrom(request));
  }

  @Post(':id/start')
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({ summary: 'Start inventory: snapshot expected quantities' })
  start(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Req() request: Request) {
    return this.inventoriesService.start(actor, id, this.contextFrom(request));
  }

  @Patch(':id/items/:itemId')
  @RequirePermissions(Permission.INVENTORY_COUNT)
  @ApiOperation({ summary: 'Save counted quantity for one item' })
  updateItem(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateInventoryItemDto,
    @Req() request: Request,
  ) {
    return this.inventoriesService.updateItem(actor, id, itemId, dto, this.contextFrom(request));
  }

  @Patch(':id/items')
  @RequirePermissions(Permission.INVENTORY_COUNT)
  @ApiOperation({ summary: 'Batch save counted quantities' })
  updateItemsBatch(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: BatchUpdateInventoryItemsDto,
    @Req() request: Request,
  ) {
    return this.inventoriesService.updateItemsBatch(actor, id, dto, this.contextFrom(request));
  }

  @Post(':id/complete')
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({ summary: 'Finalize inventory and apply stock adjustments' })
  complete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.inventoriesService.complete(actor, id, this.contextFrom(request));
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({ summary: 'Cancel DRAFT or IN_PROGRESS inventory (no stock changes)' })
  cancel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelInventoryDto,
    @Req() request: Request,
  ) {
    return this.inventoriesService.cancel(actor, id, dto, this.contextFrom(request));
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
