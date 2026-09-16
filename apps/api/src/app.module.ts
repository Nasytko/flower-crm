import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { resolve } from 'node:path';
import { AppConfigModule } from './config/app-config.module';
import { AppConfigService } from './config/app-config.service';
import { validateEnv } from './config/env.validation';
import { REQUEST_ID_HEADER, resolveRequestId } from './common/http/request-id';
import { AuthGuard } from './common/auth/auth.guard';
import { PermissionsGuard } from './common/auth/permissions.guard';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { AuditModule } from './modules/audit/audit.module';
import { ProductsModule } from './modules/products/products.module';
import { SuppliesModule } from './modules/supplies/supplies.module';
import { InventoriesModule } from './modules/inventories/inventories.module';
import { BouquetsModule } from './modules/bouquets/bouquets.module';
import { OrdersModule } from './modules/orders/orders.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            limit: 120,
          },
          {
            name: 'login',
            ttl: config.authLoginWindowSeconds * 1000,
            limit: config.authLoginMaxAttempts,
            // Named throttlers apply to every route unless skipped.
            skipIf: (context) => {
              const request = context
                .switchToHttp()
                .getRequest<{ method?: string; path?: string }>();
              return !(request.method === 'POST' && request.path === '/api/v1/auth/login');
            },
          },
        ],
      }),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        genReqId: (req, res) => {
          const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
          res.setHeader(REQUEST_ID_HEADER, requestId);
          return requestId;
        },
        customProps: (req) => ({
          requestId: req.id,
        }),
        customAttributeKeys: {
          responseTime: 'durationMs',
        },
        customLogLevel: (_req, res, error) => {
          if (res.statusCode === 503) {
            return 'warn';
          }
          if (error || res.statusCode >= 500) {
            return 'error';
          }
          if (res.statusCode >= 400) {
            return 'warn';
          }
          return 'info';
        },
        customErrorMessage: (_req, res) => {
          if (res.statusCode === 503) {
            return 'Service unavailable';
          }
          return `failed with status code ${res.statusCode}`;
        },
        serializers: {
          req: (req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res) => ({
            statusCode: res.statusCode,
          }),
          err: (err) => {
            // Health degraded (503) is an expected probe result — avoid synthetic Error noise.
            if (err?.message?.includes('503') || err?.message === 'Service unavailable') {
              return undefined;
            }
            return {
              type: err?.type,
              message: err?.message,
            };
          },
        },
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.set-cookie'],
          remove: true,
        },
        transport:
          process.env.NODE_ENV === 'development'
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
      },
    }),
    AppConfigModule,
    PrismaModule,
    WarehouseModule,
    AuthModule,
    EmployeesModule,
    ProductsModule,
    SuppliesModule,
    InventoriesModule,
    BouquetsModule,
    OrdersModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
