import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { CreateEmployeeDto, ResetPasswordDto, UpdateEmployeeDto } from './dto/employee.dto';
import { EmployeesService } from './employees.service';

@ApiTags('employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @RequirePermissions(Permission.EMPLOYEES_VIEW)
  @ApiOperation({ summary: 'List employees' })
  list() {
    return this.employeesService.list();
  }

  @Get(':id')
  @RequirePermissions(Permission.EMPLOYEES_VIEW)
  @ApiOperation({ summary: 'Get employee by id' })
  getById(@Param('id') id: string) {
    return this.employeesService.getById(id);
  }

  @Post()
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Create employee' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateEmployeeDto,
    @Req() request: Request,
  ) {
    return this.employeesService.create(actor, dto, this.contextFrom(request));
  }

  @Patch(':id')
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Update employee profile/role/status' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @Req() request: Request,
  ) {
    return this.employeesService.update(actor, id, dto, this.contextFrom(request));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Deactivate employee and revoke sessions' })
  deactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.employeesService.deactivate(actor, id, this.contextFrom(request));
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Reset employee password (director)' })
  async resetPassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
    @Req() request: Request,
  ) {
    await this.employeesService.resetPassword(actor, id, dto, this.contextFrom(request));
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
