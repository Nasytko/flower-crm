import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { PaymentsService } from './payments.service';
import {
  CancelPaymentDto,
  ConfirmPaymentDto,
  CreatePaymentDto,
  RefundPaymentDto,
} from './dto/payment.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('orders/:orderId/payments')
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'Payments and payment summary of an order' })
  list(@Param('orderId') orderId: string) {
    return this.payments.listForOrder(orderId);
  }

  @Post('orders/:orderId/payments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({
    summary:
      'Register a charge (idempotent). CASH → confirmed on an open shift; other methods → PENDING unless manually confirmed',
  })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: CreatePaymentDto,
    @Req() request: Request,
  ) {
    return this.payments.createCharge(actor, orderId, dto, this.contextFrom(request));
  }

  @Post('payments/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PAYMENTS_CONFIRM)
  @ApiOperation({ summary: 'Manually confirm a PENDING payment' })
  confirm(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmPaymentDto,
    @Req() request: Request,
  ) {
    return this.payments.confirm(actor, id, dto, this.contextFrom(request));
  }

  @Post('payments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PAYMENTS_CONFIRM)
  @ApiOperation({ summary: 'Cancel a PENDING payment (confirmed payments are never deleted)' })
  cancel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelPaymentDto,
    @Req() request: Request,
  ) {
    return this.payments.cancel(actor, id, dto, this.contextFrom(request));
  }

  @Post('payments/:id/refund')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.PAYMENTS_REFUND)
  @ApiOperation({
    summary: 'Refund a confirmed payment. CASH → REFUND_OUT; others → PENDING refund (foundation)',
  })
  refund(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
    @Req() request: Request,
  ) {
    return this.payments.refund(actor, id, dto, this.contextFrom(request));
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
