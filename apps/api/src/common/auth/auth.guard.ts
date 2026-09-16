import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../errors/app-error';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthenticatedUser } from './auth.types';
import { SessionService } from '../../modules/auth/session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
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

    request.user = user;
    return true;
  }
}
