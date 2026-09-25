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
  status: string;
}

interface ReleaseResponseBody {
  id: string;
  reservationId: string;
  invoiceId: string;
  programId: string;
  originalMoney: MoneyBody;
  convertedMoneyUsd: MoneyBody;
  conversion: { rate: string; rateDate: string; source: string };
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
// (TESTING.md). ReleasesService itself has no FX dependency at all (CLAUDE.md section
// 31), so no live Frankfurter call can occur from this flow regardless of currency.
describe('Releases (e2e)', () => {
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
        email: `releases-e2e-${Date.now()}@example.test`,
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
        name: `Releases E2E Program ${Date.now()}-${Math.random()}`,
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

  async function createActiveReservation(
    programId: string,
    invoiceId: string,
  ): Promise<string> {
    const response = await request(httpServer)
      .post(`/programs/${programId}/reservations`)
      .set('Authorization', authHeader())
      .send({ invoiceId });
    return (response.body as ReservationResponseBody).id;
  }

  it('rejects every route without a token', async () => {
    await request(httpServer)
      .post('/reservations/00000000-0000-0000-0000-000000000000/release')
      .expect(401);
    await request(httpServer)
      .get('/releases/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('releases a Reservation, marks the Invoice REPAID, and restores Program capacity', async () => {
    const programId = await createProgram('100');
    const invoiceId = await createInvoice('80');
    const reservationId = await createActiveReservation(programId, invoiceId);

    // Capacity E2E verification before Release (CLAUDE.md section 44): totalCapacityUsd
    // = 100, active Reservation = 80 -> reservedCapacityUsd = 80, availableCapacityUsd =
    // 20.
    const beforeReleaseResponse = await request(httpServer)
      .get(`/programs/${programId}`)
      .set('Authorization', authHeader());
    const beforeRelease = beforeReleaseResponse.body as ProgramResponseBody;
    expect(beforeRelease.reservedCapacityUsd).toEqual({
      amount: '80.0000',
      currency: 'USD',
    });
    expect(beforeRelease.availableCapacityUsd).toEqual({
      amount: '20.0000',
      currency: 'USD',
    });

    const releaseResponse = await request(httpServer)
      .post(`/reservations/${reservationId}/release`)
      .set('Authorization', authHeader());
    expect(releaseResponse.status).toBe(201);
    const release = releaseResponse.body as ReleaseResponseBody;

    expect(release.reservationId).toBe(reservationId);
    expect(release.invoiceId).toBe(invoiceId);
    expect(release.programId).toBe(programId);
    expect(release.originalMoney).toEqual({
      amount: '80.0000',
      currency: 'USD',
    });
    expect(release.convertedMoneyUsd).toEqual({
      amount: '80.0000',
      currency: 'USD',
    });
    expect(release.conversion.rate).toBe('1.000000');
    expect(release.conversion.source).toBe('frankfurter.dev');
    expect(release.createdByUserId).toBe(userId);

    const invoiceResponse = await request(httpServer)
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', authHeader());
    expect((invoiceResponse.body as InvoiceResponseBody).status).toBe('REPAID');

    // Capacity E2E verification after Release: reservedCapacityUsd = 0,
    // availableCapacityUsd = 100 again - no Program counter was mutated, this is purely
    // derived from the Reservation now being RELEASED (CLAUDE.md section 29).
    const afterReleaseResponse = await request(httpServer)
      .get(`/programs/${programId}`)
      .set('Authorization', authHeader());
    const afterRelease = afterReleaseResponse.body as ProgramResponseBody;
    expect(afterRelease.reservedCapacityUsd).toEqual({
      amount: '0.0000',
      currency: 'USD',
    });
    expect(afterRelease.availableCapacityUsd).toEqual({
      amount: '100.0000',
      currency: 'USD',
    });

    const getReleaseResponse = await request(httpServer)
      .get(`/releases/${release.id}`)
      .set('Authorization', authHeader());
    expect(getReleaseResponse.status).toBe(200);
    const fetched = getReleaseResponse.body as ReleaseResponseBody;
    expect(fetched.id).toBe(release.id);
    // GET returns the stored immutable FX snapshot exactly as created.
    expect(fetched.conversion).toEqual(release.conversion);
    expect(fetched.convertedMoneyUsd).toEqual(release.convertedMoneyUsd);
  });

  it('is idempotent under a duplicate release request: same Release, no duplicate capacity restoration', async () => {
    const programId = await createProgram('100');
    const invoiceId = await createInvoice('80');
    const reservationId = await createActiveReservation(programId, invoiceId);

    const firstResponse = await request(httpServer)
      .post(`/reservations/${reservationId}/release`)
      .set('Authorization', authHeader());
    expect(firstResponse.status).toBe(201);
    const first = firstResponse.body as ReleaseResponseBody;

    const secondResponse = await request(httpServer)
      .post(`/reservations/${reservationId}/release`)
      .set('Authorization', authHeader());
    expect(secondResponse.status).toBe(201);
    const second = secondResponse.body as ReleaseResponseBody;

    expect(second.id).toBe(first.id);

    const programResponse = await request(httpServer)
      .get(`/programs/${programId}`)
      .set('Authorization', authHeader());
    const program = programResponse.body as ProgramResponseBody;
    // Must NOT become 180 - capacity restored exactly once.
    expect(program.availableCapacityUsd).toEqual({
      amount: '100.0000',
      currency: 'USD',
    });
  });

  it('returns 404 for a missing Reservation', async () => {
    await request(httpServer)
      .post('/reservations/00000000-0000-0000-0000-000000000000/release')
      .set('Authorization', authHeader())
      .expect(404);
  });

  it('rejects an invalid UUID path parameter', async () => {
    await request(httpServer)
      .post('/reservations/not-a-uuid/release')
      .set('Authorization', authHeader())
      .expect(400);
    await request(httpServer)
      .get('/releases/not-a-uuid')
      .set('Authorization', authHeader())
      .expect(400);
  });

  it('returns 404 for a missing release', async () => {
    await request(httpServer)
      .get('/releases/00000000-0000-0000-0000-000000000000')
      .set('Authorization', authHeader())
      .expect(404);
  });
});
