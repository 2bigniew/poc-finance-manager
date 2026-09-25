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
  reservedCapacityUsd: MoneyBody;
  availableCapacityUsd: MoneyBody;
}

interface InvoiceResponseBody {
  id: string;
  status: string;
}

interface ReservationResponseBody {
  id: string;
  programId: string;
  invoiceId: string;
  originalMoney: MoneyBody;
  convertedMoneyUsd: MoneyBody;
  conversion: { rate: string; rateDate: string; source: string };
  status: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface RegisterResponseBody {
  user: { id: string };
  access_token: string;
}

// USD throughout: USD -> USD never calls Frankfurter (CurrencyExchangeService's
// documented shortcut), so this suite never depends on live-Frankfurter reachability
// (TESTING.md). The real Frankfurter HTTP integration is already covered by
// frankfurter.client.integration-spec.ts against a controlled local server.
describe('Reservations (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let accessToken: string;
  let userId: string;

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
        email: `reservations-e2e-${Date.now()}@example.test`,
        password: 'password123',
      });
    const registered = registerResponse.body as RegisterResponseBody;
    accessToken = registered.access_token;
    userId = registered.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function authHeader(): string {
    return `Bearer ${accessToken}`;
  }

  async function createProgram(
    totalCapacityUsdAmount: string,
  ): Promise<string> {
    const response = await request(httpServer)
      .post('/programs')
      .set('Authorization', authHeader())
      .send({
        name: `Reservations E2E Program ${Date.now()}-${Math.random()}`,
        originalCapacityAmount: totalCapacityUsdAmount,
        originalCapacityCurrency: 'USD',
        totalCapacityUsdAmount,
      });
    return (response.body as ProgramResponseBody).id;
  }

  async function createInvoice(amount: string): Promise<string> {
    const response = await request(httpServer)
      .post('/invoices')
      .set('Authorization', authHeader())
      .send({
        externalReference: `INV-${Date.now()}-${Math.random()}`,
        amount,
        currency: 'USD',
      });
    return (response.body as InvoiceResponseBody).id;
  }

  it('rejects every route without a token', async () => {
    await request(httpServer)
      .post('/programs/00000000-0000-0000-0000-000000000000/reservations')
      .send({ invoiceId: '00000000-0000-0000-0000-000000000000' })
      .expect(401);
    await request(httpServer)
      .get('/reservations/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('creates a Reservation, marks the Invoice RESERVED, and decreases Program capacity', async () => {
    const programId = await createProgram('100');
    const invoiceId = await createInvoice('30');

    const createResponse = await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId });
    expect(createResponse.status).toBe(201);
    const reservation = createResponse.body as ReservationResponseBody;

    expect(reservation.programId).toBe(programId);
    expect(reservation.invoiceId).toBe(invoiceId);
    expect(reservation.originalMoney).toEqual({
      amount: '30.0000',
      currency: 'USD',
    });
    expect(reservation.convertedMoneyUsd).toEqual({
      amount: '30.0000',
      currency: 'USD',
    });
    expect(reservation.conversion.rate).toBe('1.000000');
    expect(reservation.conversion.source).toBe('frankfurter.dev');
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.createdByUserId).toBe(userId);

    const invoiceResponse = await request(httpServer)
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', authHeader());
    expect((invoiceResponse.body as InvoiceResponseBody).status).toBe(
      'RESERVED',
    );

    // Capacity E2E verification (CLAUDE.md section 50): totalCapacityUsd = 100,
    // Reservation.convertedMoneyUsd = 30 -> reservedCapacityUsd = 30, availableCapacityUsd = 70.
    const programResponse = await request(httpServer)
      .get(`/programs/${programId}`)
      .set('Authorization', authHeader());
    const program = programResponse.body as ProgramResponseBody;
    expect(program.reservedCapacityUsd).toEqual({
      amount: '30.0000',
      currency: 'USD',
    });
    expect(program.availableCapacityUsd).toEqual({
      amount: '70.0000',
      currency: 'USD',
    });

    const getReservationResponse = await request(httpServer)
      .get(`/reservations/${reservation.id}`)
      .set('Authorization', authHeader());
    expect(getReservationResponse.status).toBe(200);
    const fetched = getReservationResponse.body as ReservationResponseBody;
    expect(fetched.id).toBe(reservation.id);
    // GET returns the stored immutable FX snapshot exactly as created.
    expect(fetched.conversion).toEqual(reservation.conversion);
    expect(fetched.convertedMoneyUsd).toEqual(reservation.convertedMoneyUsd);
  });

  it('rejects a Reservation that would exceed available capacity, leaving the Invoice OPEN and creating nothing', async () => {
    const programId = await createProgram('50');
    const invoiceId = await createInvoice('50.01');

    const createResponse = await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId });
    expect(createResponse.status).toBe(409);

    const invoiceResponse = await request(httpServer)
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', authHeader());
    expect((invoiceResponse.body as InvoiceResponseBody).status).toBe('OPEN');

    const programResponse = await request(httpServer)
      .get(`/programs/${programId}`)
      .set('Authorization', authHeader());
    expect(
      (programResponse.body as ProgramResponseBody).reservedCapacityUsd,
    ).toEqual({ amount: '0.0000', currency: 'USD' });
  });

  it('rejects reserving an Invoice that is already RESERVED', async () => {
    const programId = await createProgram('100');
    const invoiceId = await createInvoice('10');

    await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId })
      .expect(201);

    await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId })
      .expect(409);
  });

  it('returns 404 for a missing Program', async () => {
    const invoiceId = await createInvoice('10');

    await request(httpServer)
      .post('/programs/00000000-0000-0000-0000-000000000000/reservations')
      .set('Authorization', authHeader())
      .send({ invoiceId })
      .expect(404);
  });

  it('returns 404 for a missing Invoice', async () => {
    const programId = await createProgram('100');

    await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });

  it('rejects application-owned fields in the create payload', async () => {
    const programId = await createProgram('100');
    const invoiceId = await createInvoice('10');

    await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId, status: 'ACTIVE' })
      .expect(400);

    await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId, amount: '999999', currency: 'USD' })
      .expect(400);
  });

  it('rejects an invalid UUID path parameter', async () => {
    await request(httpServer)
      .get('/reservations/not-a-uuid')
      .set('Authorization', authHeader())
      .expect(400);
  });

  it('returns 404 for a missing reservation', async () => {
    await request(httpServer)
      .get('/reservations/00000000-0000-0000-0000-000000000000')
      .set('Authorization', authHeader())
      .expect(404);
  });
});
