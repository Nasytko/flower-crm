import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import {
  CancelSupplyDto,
  CorrectSupplyDto,
  CreateSupplyDto,
  SupplyQueryDto,
  UpdateSupplyDto,
} from './dto/supply.dto';
import { SuppliesService } from './supplies.service';

@ApiTags('supplies')
@ApiBearerAuth()
@Controller('supplies')
export class SuppliesController {
  constructor(private readonly suppliesService: SuppliesService) {}

  @Get()
  @RequirePermissions(Permission.SUPPLIES_VIEW)
  @ApiOperation({ summary: 'List supplies (newest first)' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: SupplyQueryDto) {
    return this.suppliesService.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.SUPPLIES_VIEW)
  @ApiOperation({ summary: 'Supply detail' })
  getById(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.suppliesService.getById(actor, id);
  }

  @Post()
  @RequirePermissions(Permission.SUPPLIES_CREATE)
  @ApiOperation({ summary: 'Create supply draft' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateSupplyDto,
    @Req() request: Request,
  ) {
    return this.suppliesService.create(actor, dto, this.contextFrom(request));
  }

  @Patch(':id')
  @RequirePermissions(Permission.SUPPLIES_CREATE)
  @ApiOperation({ summary: 'Update supply draft' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplyDto,
    @Req() request: Request,
  ) {
    return this.suppliesService.update(actor, id, dto, this.contextFrom(request));
  }

  @Post(':id/post')
  @RequirePermissions(Permission.SUPPLIES_POST)
  @ApiOperation({ summary: 'Post supply (or post correction with reversal)' })
  post(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Req() request: Request) {
    return this.suppliesService.post(actor, id, this.contextFrom(request));
  }

  @Post(':id/correct')
  @RequirePermissions(Permission.SUPPLIES_CORRECT)
  @ApiOperation({ summary: 'Create correction draft from posted supply' })
  correct(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CorrectSupplyDto,
    @Req() request: Request,
  ) {
    return this.suppliesService.createCorrection(actor, id, dto, this.contextFrom(request));
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.SUPPLIES_CORRECT)
  @ApiOperation({ summary: 'Cancel posted supply if lots untouched' })
  cancel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelSupplyDto,
    @Req() request: Request,
  ) {
    return this.suppliesService.cancel(actor, id, dto, this.contextFrom(request));
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
