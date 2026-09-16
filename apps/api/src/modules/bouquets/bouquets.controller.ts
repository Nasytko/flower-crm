import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { BouquetQueryDto, CreateBouquetDto, UpdateBouquetDto } from './dto/bouquet.dto';
import { BouquetsService } from './bouquets.service';

@ApiTags('bouquets')
@ApiBearerAuth()
@Controller('bouquets')
export class BouquetsController {
  constructor(private readonly bouquetsService: BouquetsService) {}

  @Get()
  @RequirePermissions(Permission.BOUQUETS_VIEW)
  @ApiOperation({ summary: 'List bouquets (recipes)' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: BouquetQueryDto) {
    return this.bouquetsService.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.BOUQUETS_VIEW)
  @ApiOperation({ summary: 'Bouquet detail with composition' })
  getById(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.bouquetsService.getById(actor, id);
  }

  @Post()
  @RequirePermissions(Permission.BOUQUETS_MANAGE)
  @ApiOperation({ summary: 'Create bouquet recipe' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateBouquetDto,
    @Req() request: Request,
  ) {
    return this.bouquetsService.create(actor, dto, this.contextFrom(request));
  }

  @Patch(':id')
  @RequirePermissions(Permission.BOUQUETS_MANAGE)
  @ApiOperation({ summary: 'Update bouquet metadata/composition (optimistic concurrency)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBouquetDto,
    @Req() request: Request,
  ) {
    return this.bouquetsService.update(actor, id, dto, this.contextFrom(request));
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
