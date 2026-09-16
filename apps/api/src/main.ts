import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(AppConfigService);

  app.setGlobalPrefix('api/v1');
  const expressApp = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  if (config.trustProxy !== false) {
    expressApp.set('trust proxy', config.trustProxy);
  }

  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction ? undefined : false,
    }),
  );
  app.use(cookieParser());
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));

  app.enableCors({
    origin: config.webUrl,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AppExceptionFilter());

  // Allow Docker SIGTERM to close HTTP connections and run OnModuleDestroy (Prisma).
  app.enableShutdownHooks();

  if (!config.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Flower CRM API')
      .setDescription('Internal REST API for the flower shop CRM/ERP')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      useGlobalPrefix: true,
    });
  }

  // Bind all interfaces inside the container; host Compose maps 127.0.0.1 only.
  await app.listen(config.apiPort, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on 0.0.0.0:${config.apiPort}`);
  if (!config.isProduction) {
    logger.log(`Swagger available at http://localhost:${config.apiPort}/api/v1/docs`);
  }
}

void bootstrap();
