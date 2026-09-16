import { Test } from '@nestjs/testing';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthService', () => {
  it('returns ok when PostgreSQL is reachable', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: { ping: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);

    await expect(service.getHealth()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
  });

  it('returns degraded when PostgreSQL is unreachable', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: { ping: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);

    await expect(service.getHealth()).resolves.toEqual({
      status: 'degraded',
      database: 'down',
    });
  });
});
