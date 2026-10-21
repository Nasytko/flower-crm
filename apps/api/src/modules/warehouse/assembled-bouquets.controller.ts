import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { AssembledBouquetService } from './assembled-bouquet.service';
import {
  AdjustBouquetDto,
  AssembleBouquetDto,
  DisassembleBouquetDto,
  IssueBouquetDto,
  LinkBouquetDto,
  WriteOffBouquetDto,
} from './dto/assembled-bouquet.dto';

@ApiTags('assembled-bouquets')
@ApiBearerAuth()
@Controller('assembled-bouquets')
export class AssembledBouquetsController {
  constructor(private readonly service: AssembledBouquetService) {}

  @Get('display')
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'List display (vitrine) assembled bouquets' })
  listDisplay(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listDisplay(user);
  }

  @Get()
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'List assembled bouquets; optional ?productId= filter' })
  listByProduct(@CurrentUser() user: AuthenticatedUser, @Query('productId') productId?: string) {
    if (!productId) return this.service.listDisplay(user);
    return this.service.listContainingProduct(productId, user);
  }

  @Get(':id')
  @RequirePermissions(Permission.ORDERS_VIEW)
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.getById(id, user);
  }

  @Post()
  @RequirePermissions(Permission.ORDERS_ASSEMBLE)
  @ApiOperation({ summary: 'Assemble physical bouquet (order or vitrine)' })
  assemble(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AssembleBouquetDto,
    @Req() request: Request,
  ) {
    return this.service.assemble(user, dto, this.contextFrom(request));
  }

  @Post(':id/disassemble')
  @RequirePermissions(Permission.ORDERS_ASSEMBLE)
  disassemble(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DisassembleBouquetDto,
    @Req() request: Request,
  ) {
    return this.service.disassemble(user, id, dto, this.contextFrom(request));
  }

  @Post(':id/adjust')
  @RequirePermissions(Permission.ORDERS_ASSEMBLE)
  adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdjustBouquetDto,
    @Req() request: Request,
  ) {
    return this.service.adjust(user, id, dto, this.contextFrom(request));
  }

  @Post(':id/issue')
  @RequirePermissions(Permission.ORDERS_ISSUE)
  issue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: IssueBouquetDto,
    @Req() request: Request,
  ) {
    return this.service.issue(user, id, dto.expectedVersion, this.contextFrom(request));
  }

  @Post(':id/write-off')
  @RequirePermissions(Permission.ORDERS_ASSEMBLE)
  writeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: WriteOffBouquetDto,
    @Req() request: Request,
  ) {
    return this.service.writeOffAssembled(
      user,
      id,
      dto.expectedVersion,
      dto.reason,
      this.contextFrom(request),
    );
  }

  @Post(':id/link-order')
  @RequirePermissions(Permission.ORDERS_ASSEMBLE)
  link(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: LinkBouquetDto,
    @Req() request: Request,
  ) {
    return this.service.linkToOrder(
      user,
      id,
      dto.orderId,
      dto.orderItemId ?? null,
      dto.expectedVersion,
      this.contextFrom(request),
    );
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
