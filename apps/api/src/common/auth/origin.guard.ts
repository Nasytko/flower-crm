import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { AppError } from '../errors/app-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const allowed = this.config.webUrl.replace(/\/$/, '');

    if (typeof origin === 'string' && origin.replace(/\/$/, '') === allowed) {
      return true;
    }

    if (typeof referer === 'string') {
      try {
        const refererOrigin = new URL(referer).origin;
        if (refererOrigin === allowed) {
          return true;
        }
      } catch {
        // fall through
      }
    }

    // Non-browser clients (tests/curl) may omit Origin in development/test.
    // Production requires Origin or Referer matching WEB_URL (CSRF defense for cookie auth).
    if (!origin && !referer) {
      if (!this.config.isProduction) {
        return true;
      }
      throw new AppError(
        'FORBIDDEN_ORIGIN',
        'Запрос отклонён политикой Origin',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    throw new AppError(
      'FORBIDDEN_ORIGIN',
      'Запрос отклонён политикой Origin',
      {},
      HttpStatus.FORBIDDEN,
    );
  }
}
