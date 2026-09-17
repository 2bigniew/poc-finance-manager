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

interface InvoiceResponseBody {
  id: string;
  externalReference: string;
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

// Uses USD-denominated invoices throughout: USD -> USD never calls Frankfurter
// (CurrencyExchangeService's documented shortcut), so this suite never depends on
// network/live-Frankfurter reachability (TESTING.md: "MUST NOT call the live
// Frankfurter service"). The real Frankfurter HTTP integration is already covered by
// frankfurter.client.integration-spec.ts against a controlled local server.
describe('Invoices (e2e)', () => {
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
        email: `invoices-e2e-${Date.now()}@example.test`,
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

  it('rejects every route without a token', async () => {
    await request(httpServer).post('/invoices').send({}).expect(401);
    await request(httpServer).get('/invoices').expect(401);
    await request(httpServer)
      .get('/invoices/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('creates a USD invoice with rate=1 and no conversion loss, owned by the caller', async () => {
    const createResponse = await request(httpServer)
      .post('/invoices')
      .set('Authorization', authHeader())
      .send({
        externalReference: `INV-${Date.now()}`,
        amount: '1234.56',
        currency: 'USD',
      });
    expect(createResponse.status).toBe(201);
    const created = createResponse.body as InvoiceResponseBody;

    expect(created.originalMoney).toEqual({
      amount: '1234.5600',
      currency: 'USD',
    });
    expect(created.convertedMoneyUsd).toEqual({
      amount: '1234.5600',
      currency: 'USD',
    });
    // conversion_rate is NUMERIC(19,6), so PostgreSQL normalizes the stored/returned
    // scale - same reason originalMoney/convertedMoneyUsd come back as "1234.5600".
    expect(created.conversion.rate).toBe('1.000000');
    expect(created.conversion.source).toBe('frankfurter.dev');
    expect(created.status).toBe('OPEN');
    expect(created.createdByUserId).toBe(userId);

    const getResponse = await request(httpServer)
      .get(`/invoices/${created.id}`)
      .set('Authorization', authHeader());
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as InvoiceResponseBody).id).toBe(created.id);

    const listResponse = await request(httpServer)
      .get('/invoices')
      .set('Authorization', authHeader());
    expect(listResponse.status).toBe(200);
    const listed = listResponse.body as InvoiceResponseBody[];
    expect(listed.map((invoice) => invoice.id)).toContain(created.id);
  });

  it('never lets the client impersonate another creator via createdByUserId', async () => {
    const otherEmail = `invoices-e2e-other-${Date.now()}@example.test`;
    const otherRegisterResponse = await request(httpServer)
      .post('/users/register')
      .send({ email: otherEmail, password: 'password123' });
    const other = otherRegisterResponse.body as RegisterResponseBody;

    const createResponse = await request(httpServer)
      .post('/invoices')
      .set('Authorization', `Bearer ${other.access_token}`)
      .send({
        externalReference: `INV-${Date.now()}`,
        amount: '10',
        currency: 'USD',
      });

    expect(createResponse.status).toBe(201);
    const created = createResponse.body as InvoiceResponseBody;
    expect(created.createdByUserId).toBe(other.user.id);
    expect(created.createdByUserId).not.toBe(userId);
  });

  it('rejects application-owned fields in the create payload (status, createdByUserId, id)', async () => {
    await request(httpServer)
      .post('/invoices')
      .set('Authorization', authHeader())
      .send({
        externalReference: `INV-${Date.now()}`,
        amount: '10',
        currency: 'USD',
        status: 'REPAID',
      })
      .expect(400);

    await request(httpServer)
      .post('/invoices')
      .set('Authorization', authHeader())
      .send({
        externalReference: `INV-${Date.now()}`,
        amount: '10',
        currency: 'USD',
        createdByUserId: '00000000-0000-0000-0000-000000000000',
      })
      .expect(400);
  });

  it('rejects a negative amount', async () => {
    await request(httpServer)
      .post('/invoices')
      .set('Authorization', authHeader())
      .send({
        externalReference: `INV-${Date.now()}`,
        amount: '-100',
        currency: 'USD',
      })
      .expect(400);
  });

  it('rejects a malformed currency code', async () => {
    await request(httpServer)
      .post('/invoices')
      .set('Authorization', authHeader())
      .send({
        externalReference: `INV-${Date.now()}`,
        amount: '100',
        currency: 'US',
      })
      .expect(400);
  });

  it('rejects an invalid UUID path parameter', async () => {
    await request(httpServer)
      .get('/invoices/not-a-uuid')
      .set('Authorization', authHeader())
      .expect(400);
  });

  it('returns 404 for a missing invoice', async () => {
    await request(httpServer)
      .get('/invoices/00000000-0000-0000-0000-000000000000')
      .set('Authorization', authHeader())
      .expect(404);
  });
});
