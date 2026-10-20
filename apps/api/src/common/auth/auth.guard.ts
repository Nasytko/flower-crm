import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../errors/app-error';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ALLOW_LOCKED_KEY } from './allow-locked.decorator';
import { REQUIRE_ELEVATION_KEY } from './require-elevation.decorator';
import type { AuthenticatedUser } from './auth.types';
import { isElevated } from './auth.types';
import { SessionService } from '../../modules/auth/session.service';
import { WorkstationService } from '../../modules/security/workstation.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : undefined;

    if (!token) {
      throw new AppError('UNAUTHORIZED', 'Требуется аутентификация', {}, HttpStatus.UNAUTHORIZED);
    }

    const user = await this.sessions.resolveAuthenticatedUser(token);
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Требуется аутентификация', {}, HttpStatus.UNAUTHORIZED);
    }

    const allowLocked = this.reflector.getAllAndOverride<boolean>(ALLOW_LOCKED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Enforce idle lock on protected routes before allowing business work.
    // AllowLocked endpoints (status/close) still need an authenticated session, but
    // must remain reachable after lock — skip idle re-check there when already usable.
    if (!allowLocked && user.workSessionId) {
      const workstation = this.moduleRef.get(WorkstationService, { strict: false });
      if (workstation) {
        const locked = await workstation.enforceIdleLockIfNeeded(user);
        if (locked) {
          throw new AppError(
            'WORKSTATION_LOCKED',
            'Рабочее место заблокировано',
            {},
            HttpStatus.UNAUTHORIZED,
          );
        }
      }
    }

    if (user.lockedAt && !allowLocked) {
      throw new AppError(
        'WORKSTATION_LOCKED',
        'Рабочее место заблокировано',
        {},
        HttpStatus.UNAUTHORIZED,
      );
    }

    const requireElevation = this.reflector.getAllAndOverride<boolean>(REQUIRE_ELEVATION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requireElevation && !isElevated(user)) {
      throw new AppError(
        'STEP_UP_REQUIRED',
        'Подтвердите пароль для выполнения операции',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    request.user = user;
    return true;
  }
}
