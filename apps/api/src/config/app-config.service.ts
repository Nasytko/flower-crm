import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv, NodeEnv } from './env.validation';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<AppEnv, true>) {}

  get nodeEnv(): NodeEnv {
    return this.configService.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get databaseUrl(): string {
    return this.configService.get('DATABASE_URL', { infer: true });
  }

  get apiPort(): number {
    return this.configService.get('API_PORT', { infer: true });
  }

  get webUrl(): string {
    return this.configService.get('WEB_URL', { infer: true });
  }

  get jwtAccessSecret(): string {
    return this.configService.get('JWT_ACCESS_SECRET', { infer: true });
  }

  get jwtAccessTtlSeconds(): number {
    return this.configService.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  get sessionTtlSeconds(): number {
    return this.configService.get('SESSION_TTL_SECONDS', { infer: true });
  }

  get authCookieName(): string {
    return this.configService.get('AUTH_COOKIE_NAME', { infer: true });
  }

  get authLoginMaxAttempts(): number {
    return this.configService.get('AUTH_LOGIN_MAX_ATTEMPTS', { infer: true });
  }

  get authLoginWindowSeconds(): number {
    return this.configService.get('AUTH_LOGIN_WINDOW_SECONDS', { infer: true });
  }

  get trustProxy(): false | number {
    return this.configService.get('TRUST_PROXY', { infer: true });
  }

  get businessTimeZone(): string {
    return this.configService.get('BUSINESS_TIME_ZONE', { infer: true });
  }

  get yandexMapsApiKey(): string | undefined {
    return this.configService.get('YANDEX_MAPS_API_KEY', { infer: true });
  }

  /** Optional Suggest bias center as "lon,lat". */
  get yandexSuggestLl(): string | undefined {
    return this.configService.get('YANDEX_SUGGEST_LL', { infer: true });
  }
}
