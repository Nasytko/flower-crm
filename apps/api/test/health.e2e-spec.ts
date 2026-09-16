import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';

describe('Health endpoint', () => {
  let app: INestApplication;
  const ping = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        ping,
        $disconnect: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    ping.mockReset();
  });

  it('returns 200 when the database is up', async () => {
    ping.mockResolvedValue(true);

    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(HttpStatus.OK);

    expect(response.body).toEqual({ status: 'ok', database: 'up' });
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('returns 503 when the database is down', async () => {
    ping.mockResolvedValue(false);

    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(HttpStatus.SERVICE_UNAVAILABLE);

    expect(response.body).toEqual({ status: 'degraded', database: 'down' });
  });

  it('echoes a safe incoming request id', async () => {
    ping.mockResolvedValue(true);

    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-request-id', 'integration-request-id')
      .expect(HttpStatus.OK);

    expect(response.headers['x-request-id']).toBe('integration-request-id');
  });
});
