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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DeviceAccessMode, Permission, WorkSessionCloseReason } from '@erp/shared';
import type { Request, Response } from 'express';
import { Authenticated } from '../../common/auth/authenticated.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { AllowLocked } from '../../common/auth/allow-locked.decorator';
import { RequireElevation } from '../../common/auth/require-elevation.decorator';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { OriginGuard } from '../../common/auth/origin.guard';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUEST_ID_HEADER } from '../../common/http/request-id';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { SecurityPolicyService } from './security-policy.service';
import { TrustedDeviceService, DEVICE_COOKIE } from './trusted-device.service';
import { WorkstationService } from './workstation.service';
import { EmployeePinService } from './employee-pin.service';

class UpdatePolicyDto {
  @IsOptional() @IsBoolean() pinEnabledOrg?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) deviceTrustDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) workSessionMaxHours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) idleLockMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(10) pinMaxAttempts?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(60) pinLockoutMinutes?: number;
  @IsOptional() @IsBoolean() allowEmployeeSwitch?: boolean;
}

class TrustDeviceDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsEnum(DeviceAccessMode) accessMode!: DeviceAccessMode;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedUserIds?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) trustDays?: number;
}

class UpdateDeviceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsEnum(DeviceAccessMode) accessMode?: DeviceAccessMode;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedUserIds?: string[];
}

class PinUnlockDto {
  @IsString() userId!: string;
  @IsString() @MinLength(6) @MaxLength(6) pin!: string;
}

@ApiTags('security')
@ApiBearerAuth()
@Controller()
@UseGuards(OriginGuard)
export class SecurityController {
  constructor(
    private readonly policy: SecurityPolicyService,
    private readonly devices: TrustedDeviceService,
    private readonly workstation: WorkstationService,
    private readonly pins: EmployeePinService,
  ) {}

  @Get('security/policy')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @ApiOperation({ summary: 'Get org security policy' })
  getPolicy() {
    return this.policy.get();
  }

  @Patch('security/policy')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @RequireElevation()
  @ApiOperation({ summary: 'Update security policy (step-up required)' })
  updatePolicy(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdatePolicyDto,
    @Req() request: Request,
  ) {
    return this.policy.update(actor, dto, this.contextFrom(request));
  }

  @Get('security/devices')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  listDevices(@Req() request: Request) {
    const token = request.cookies?.[DEVICE_COOKIE] as string | undefined;
    return this.devices.list(token);
  }

  @Post('security/devices/trust-current')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @RequireElevation()
  async trustCurrent(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: TrustDeviceDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.devices.trustCurrent(actor, dto, this.contextFrom(request), response);
  }

  @Patch('security/devices/:id')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @RequireElevation()
  updateDevice(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
    @Req() request: Request,
  ) {
    return this.devices.update(actor, id, dto, this.contextFrom(request));
  }

  @Post('security/devices/:id/extend')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @RequireElevation()
  extendDevice(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { trustDays?: number },
    @Req() request: Request,
  ) {
    return this.devices.extend(actor, id, body.trustDays, this.contextFrom(request));
  }

  @Post('security/devices/:id/force-lock')
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @RequireElevation()
  forceLock(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.workstation.forceLockDevice(actor, id, this.contextFrom(request));
  }

  @Delete('security/devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.SECURITY_POLICY_MANAGE)
  @RequireElevation()
  async revokeDevice(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = request.cookies?.[DEVICE_COOKIE] as string | undefined;
    await this.devices.revoke(actor, id, this.contextFrom(request), response, token);
  }

  @Get('auth/workstation/status')
  @Authenticated()
  @AllowLocked()
  status(@CurrentUser() actor: AuthenticatedUser, @Req() request: Request) {
    const token = request.cookies?.[DEVICE_COOKIE] as string | undefined;
    return this.workstation.status(actor, token);
  }

  @Post('auth/work-session/open')
  @Authenticated()
  openWork(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const token = request.cookies?.[DEVICE_COOKIE] as string | undefined;
    return this.workstation.openWorkSession(actor, token, this.contextFrom(request));
  }

  @Post('auth/work-session/close')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @AllowLocked()
  async closeWork(@CurrentUser() actor: AuthenticatedUser, @Req() request: Request) {
    await this.workstation.closeWorkSession(
      actor,
      WorkSessionCloseReason.MANUAL,
      this.contextFrom(request),
    );
  }

  @Post('auth/workstation/lock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  lock(@CurrentUser() actor: AuthenticatedUser, @Req() request: Request) {
    return this.workstation.lock(actor, this.contextFrom(request));
  }

  @Post('auth/workstation/activity')
  @Authenticated()
  activity(@CurrentUser() actor: AuthenticatedUser) {
    return this.workstation.recordUserActivity(actor);
  }

  @Public()
  @Get('auth/pin/candidates')
  candidates(@Req() request: Request) {
    const token = request.cookies?.[DEVICE_COOKIE] as string | undefined;
    return this.workstation.listPinCandidates(token);
  }

  @Public()
  @Post('auth/pin/unlock')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle({ default: true })
  @Throttle({ pin: {} })
  unlock(
    @Body() dto: PinUnlockDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = request.cookies?.[DEVICE_COOKIE] as string | undefined;
    return this.workstation.unlockWithPin(dto, token, this.contextFrom(request), response);
  }

  @Post('employees/:id/pin/enable')
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @RequireElevation()
  enablePin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.pins.enable(actor, id, this.contextFrom(request));
  }

  @Post('employees/:id/pin/disable')
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @RequireElevation()
  disablePin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.pins.disable(actor, id, this.contextFrom(request));
  }

  @Post('employees/:id/pin/generate')
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @RequireElevation()
  generatePin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.pins.generate(actor, id, this.contextFrom(request));
  }

  @Post('employees/:id/pin/revoke-sessions')
  @RequirePermissions(Permission.EMPLOYEES_MANAGE)
  @RequireElevation()
  revokePinSessions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.pins.revokeQuickSessions(actor, id, this.contextFrom(request));
  }

  @Get('employees/:id/pin')
  @RequirePermissions(Permission.EMPLOYEES_VIEW)
  pinStatus(@Param('id') id: string) {
    return this.pins.statusDto(id);
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
