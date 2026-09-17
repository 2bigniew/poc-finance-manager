import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@app/app.module';
import { configureApp } from '@app/configure-app';
import type { Server } from 'node:http';

describe('Health (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports the process is alive', async () => {
    const response = await request(httpServer).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /readiness reports PostgreSQL connectivity', async () => {
    const response = await request(httpServer).get('/readiness');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', postgres: 'ok' });
  });
});
