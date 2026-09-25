import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@app/app.module';
import { configureApp } from '@app/configure-app';
import type { Server } from 'node:http';

interface MoneyBody {
  amount: string;
  currency: string;
}

interface ProgramResponseBody {
  id: string;
  name: string;
  originalCapacity: MoneyBody;
  totalCapacityUsd: MoneyBody;
  reservedCapacityUsd: MoneyBody;
  availableCapacityUsd: MoneyBody;
  treasuryVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface RegisterResponseBody {
  access_token: string;
}

describe('Programs (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let accessToken: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    httpServer = app.getHttpServer() as Server;

    const registerResponse = await request(httpServer)
      .post('/users/register')
      .send({
        email: `programs-e2e-${Date.now()}@example.test`,
        password: 'password123',
      });
    const registered = registerResponse.body as RegisterResponseBody;
    accessToken = registered.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  function authHeader(): string {
    return `Bearer ${accessToken}`;
  }

  it('rejects every route without a token', async () => {
    await request(httpServer).post('/programs').send({}).expect(401);
    await request(httpServer).get('/programs').expect(401);
    await request(httpServer)
      .get('/programs/00000000-0000-0000-0000-000000000000')
      .expect(401);
    await request(httpServer)
      .patch('/programs/00000000-0000-0000-0000-000000000000')
      .send({})
      .expect(401);
    await request(httpServer)
      .delete('/programs/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('supports the full CRUD lifecycle with a valid access token, with exact decimal capacity', async () => {
    const createResponse = await request(httpServer)
      .post('/programs')
      .set('Authorization', authHeader())
      .send({
        name: 'Early Payment Program',
        originalCapacityAmount: '1000',
        originalCapacityCurrency: 'EUR',
        totalCapacityUsdAmount: '1000',
      });
    expect(createResponse.status).toBe(201);
    const created = createResponse.body as ProgramResponseBody;

    expect(created.name).toBe('Early Payment Program');
    expect(created.originalCapacity).toEqual({
      amount: '1000.0000',
      currency: 'EUR',
    });
    expect(created.totalCapacityUsd).toEqual({
      amount: '1000.0000',
      currency: 'USD',
    });
    // A freshly created Program has no active Reservations against it, so all capacity
    // is available: reservedCapacityUsd = 0, availableCapacityUsd = totalCapacityUsd
    // (now derived from real Reservation data via ReservedCapacityPort, not hardcoded -
    // see programs.service.ts getCapacitySummary()).
    expect(created.reservedCapacityUsd).toEqual({
      amount: '0.0000',
      currency: 'USD',
    });
    expect(created.availableCapacityUsd).toEqual({
      amount: '1000.0000',
      currency: 'USD',
    });
    expect(created.treasuryVersion).toBe(0);

    const getResponse = await request(httpServer)
      .get(`/programs/${created.id}`)
      .set('Authorization', authHeader());
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ProgramResponseBody).id).toBe(created.id);

    const listResponse = await request(httpServer)
      .get('/programs')
      .set('Authorization', authHeader());
    expect(listResponse.status).toBe(200);
    const listed = listResponse.body as ProgramResponseBody[];
    expect(listed.map((program) => program.id)).toContain(created.id);

    const updateResponse = await request(httpServer)
      .patch(`/programs/${created.id}`)
      .set('Authorization', authHeader())
      .send({ name: 'Renamed Program' });
    expect(updateResponse.status).toBe(200);
    const updated = updateResponse.body as ProgramResponseBody;
    expect(updated.name).toBe('Renamed Program');
    // Capacity/treasuryVersion must be untouched by an ordinary client PATCH - they are
    // treasury-owned, not client-mutable (BUSINESS.md; CLAUDE.md Update Program).
    expect(updated.totalCapacityUsd).toEqual(created.totalCapacityUsd);
    expect(updated.treasuryVersion).toBe(created.treasuryVersion);

    await request(httpServer)
      .delete(`/programs/${created.id}`)
      .set('Authorization', authHeader())
      .expect(204);

    const afterDeleteResponse = await request(httpServer)
      .get(`/programs/${created.id}`)
      .set('Authorization', authHeader());
    expect(afterDeleteResponse.status).toBe(404);
  });

  it('rejects treasury-owned fields on update (totalCapacityUsd/treasuryVersion are not client-settable)', async () => {
    const createResponse = await request(httpServer)
      .post('/programs')
      .set('Authorization', authHeader())
      .send({
        name: 'Guarded Program',
        originalCapacityAmount: '500',
        originalCapacityCurrency: 'USD',
        totalCapacityUsdAmount: '500',
      });
    const created = createResponse.body as ProgramResponseBody;

    // The global ValidationPipe (forbidNonWhitelisted) rejects unknown/forbidden fields
    // outright, rather than silently accepting and ignoring them.
    await request(httpServer)
      .patch(`/programs/${created.id}`)
      .set('Authorization', authHeader())
      .send({ totalCapacityUsdAmount: '999999' })
      .expect(400);

    await request(httpServer)
      .patch(`/programs/${created.id}`)
      .set('Authorization', authHeader())
      .send({ treasuryVersion: 99 })
      .expect(400);
  });

  it('rejects a negative capacity amount on create', async () => {
    await request(httpServer)
      .post('/programs')
      .set('Authorization', authHeader())
      .send({
        name: 'Invalid Program',
        originalCapacityAmount: '-100',
        originalCapacityCurrency: 'USD',
        totalCapacityUsdAmount: '100',
      })
      .expect(400);
  });

  it('rejects an invalid UUID path parameter', async () => {
    await request(httpServer)
      .get('/programs/not-a-uuid')
      .set('Authorization', authHeader())
      .expect(400);
  });

  it('returns 404 for a missing program', async () => {
    await request(httpServer)
      .get('/programs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', authHeader())
      .expect(404);
  });
});
