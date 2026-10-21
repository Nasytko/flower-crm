import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { CashShiftService } from './cash-shift.service';
import {
  CashMovementInputDto,
  CloseCashShiftDto,
  ListCashShiftsQueryDto,
  OpenCashShiftDto,
} from './dto/cash.dto';

@ApiTags('cash')
@ApiBearerAuth()
@Controller()
export class CashShiftController {
  constructor(private readonly shifts: CashShiftService) {}

  @Get('cash-registers')
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({ summary: 'List cash registers with their currently open shift' })
  registers() {
    return this.shifts.listRegisters();
  }

  @Get('cash-shifts/current')
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({ summary: 'Current OPEN shift of the main register (null when closed) — for POS' })
  async current(@Query('cashRegisterId') cashRegisterId?: string) {
    // Return `{ shift }` so an empty result is still valid JSON for clients.
    return { shift: await this.shifts.getCurrent(cashRegisterId || undefined) };
  }

  @Get('cash-shifts')
  @RequirePermissions(Permission.CASH_SHIFT_MANAGE)
  @ApiOperation({ summary: 'List cash shifts (optionally by status)' })
  list(@Query() query: ListCashShiftsQueryDto) {
    return this.shifts.list(query.status);
  }

  @Get('cash-shifts/:id')
  @RequirePermissions(Permission.CASH_SHIFT_MANAGE)
  @ApiOperation({ summary: 'Cash shift detail with movements and expected-cash summary' })
  getById(@Param('id') id: string) {
    return this.shifts.getById(id);
  }

  @Post('cash-shifts/open')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.CASH_SHIFT_MANAGE)
  @ApiOperation({ summary: 'Open a cash shift (one OPEN shift per register)' })
  open(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: OpenCashShiftDto,
    @Req() request: Request,
  ) {
    return this.shifts.open(actor, dto, this.contextFrom(request));
  }

  @Post('cash-shifts/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CASH_SHIFT_MANAGE)
  @ApiOperation({ summary: 'Close a cash shift with counted cash' })
  close(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CloseCashShiftDto,
    @Req() request: Request,
  ) {
    return this.shifts.close(actor, id, dto, this.contextFrom(request));
  }

  @Post('cash-shifts/:id/movements')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.CASH_SHIFT_MANAGE)
  @ApiOperation({ summary: 'Add FLOAT_IN / FLOAT_OUT / ADJUSTMENT movement' })
  addMovement(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CashMovementInputDto,
    @Req() request: Request,
  ) {
    return this.shifts.addMovement(actor, id, dto, this.contextFrom(request));
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
