import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission, roleHasAllPermissions } from '@erp/shared';
import type { Request } from 'express';
import { AppError } from '../errors/app-error';
import { AUTHENTICATED_ONLY_KEY } from './authenticated.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import type { AuthenticatedUser } from './auth.types';

/**
 * Fail-closed RBAC: non-public handlers must declare either
 * `@RequirePermissions(...)` or `@Authenticated()`.
 * Omitting both denies access (prevents accidental open business endpoints).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Требуется аутентификация', {}, HttpStatus.UNAUTHORIZED);
    }

    if (required && required.length > 0) {
      if (!roleHasAllPermissions(user.role, required)) {
        throw new AppError('FORBIDDEN', 'Недостаточно прав', {}, HttpStatus.FORBIDDEN);
      }
      return true;
    }

    if (authenticatedOnly) {
      return true;
    }

    throw new AppError(
      'FORBIDDEN',
      'Эндпоинт не сконфигурирован: требуется @RequirePermissions или @Authenticated',
      {},
      HttpStatus.FORBIDDEN,
    );
  }
}
