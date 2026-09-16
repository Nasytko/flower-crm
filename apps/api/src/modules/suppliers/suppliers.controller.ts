import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { CreateSupplierDto, SupplierQueryDto, UpdateSupplierDto } from './dto/supplier.dto';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @RequirePermissions(Permission.SUPPLIES_VIEW)
  @ApiOperation({ summary: 'List suppliers' })
  list(@Query() query: SupplierQueryDto) {
    return this.suppliersService.list(query);
  }

  @Get('options')
  @RequirePermissions(Permission.SUPPLIES_VIEW)
  @ApiOperation({ summary: 'Active suppliers for select lists' })
  options() {
    return this.suppliersService.listActiveOptions();
  }

  @Get(':id')
  @RequirePermissions(Permission.SUPPLIES_VIEW)
  @ApiOperation({ summary: 'Get supplier' })
  getById(@Param('id') id: string) {
    return this.suppliersService.getById(id);
  }

  @Post()
  @RequirePermissions(Permission.SUPPLIES_CREATE)
  @ApiOperation({ summary: 'Create supplier' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateSupplierDto,
    @Req() request: Request,
  ) {
    return this.suppliersService.create(actor, dto, this.contextFrom(request));
  }

  @Patch(':id')
  @RequirePermissions(Permission.SUPPLIES_CREATE)
  @ApiOperation({ summary: 'Update supplier' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
    @Req() request: Request,
  ) {
    return this.suppliersService.update(actor, id, dto, this.contextFrom(request));
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
