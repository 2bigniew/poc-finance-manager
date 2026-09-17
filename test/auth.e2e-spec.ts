import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@app/app.module';
import { configureApp } from '@app/configure-app';
import type { Server } from 'node:http';

interface RegisterResponseBody {
  user: { id: string; email: string };
  access_token: string;
  refresh_token: string;
}

interface TokenPairResponseBody {
  access_token: string;
  refresh_token: string;
}

describe('Auth (e2e)', () => {
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

  it('registration succeeds and returns a safe user plus a token pair', async () => {
    const email = `register-${Date.now()}@example.test`;
    const response = await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' });

    expect(response.status).toBe(201);
    const body = response.body as RegisterResponseBody;
    expect(body.user).toMatchObject({ email });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
  });

  it('rejects registering a duplicate email with 409 Conflict', async () => {
    const email = `dup-${Date.now()}@example.test`;
    await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' })
      .expect(201);

    await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' })
      .expect(409);
  });

  it('rejects invalid registration input through the global validation pipeline', async () => {
    await request(httpServer)
      .post('/users/register')
      .send({ email: 'not-an-email', password: 'password123' })
      .expect(400);

    await request(httpServer)
      .post('/users/register')
      .send({ email: `missing-password-${Date.now()}@example.test` })
      .expect(400);

    await request(httpServer)
      .post('/users/register')
      .send({
        email: `too-short-${Date.now()}@example.test`,
        password: 'short',
      })
      .expect(400);

    await request(httpServer)
      .post('/users/register')
      .send({
        email: `unknown-field-${Date.now()}@example.test`,
        password: 'password123',
        isAdmin: true,
      })
      .expect(400);
  });

  it('login succeeds and returns a token pair', async () => {
    const email = `login-${Date.now()}@example.test`;
    await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' })
      .expect(201);

    const response = await request(httpServer)
      .post('/users/login')
      .send({ email, password: 'password123' });

    expect(response.status).toBe(200);
    const body = response.body as TokenPairResponseBody;
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
  });

  it('rejects login with the wrong password and with an unknown email identically', async () => {
    const email = `wrong-password-${Date.now()}@example.test`;
    await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' })
      .expect(201);

    const wrongPasswordResponse = await request(httpServer)
      .post('/users/login')
      .send({ email, password: 'incorrect-password' });
    const unknownEmailResponse = await request(httpServer)
      .post('/users/login')
      .send({
        email: `unknown-${Date.now()}@example.test`,
        password: 'incorrect-password',
      });

    expect(wrongPasswordResponse.status).toBe(401);
    expect(unknownEmailResponse.status).toBe(401);
    expect(unknownEmailResponse.body).toEqual(wrongPasswordResponse.body);
  });

  it('rejects a domain request with no token', async () => {
    await request(httpServer).get('/users').expect(401);
  });

  it('rejects a domain request with an invalid token', async () => {
    await request(httpServer)
      .get('/users')
      .set('Authorization', 'Bearer garbage')
      .expect(401);
  });

  it('accepts a domain request with a valid access token', async () => {
    const email = `domain-access-${Date.now()}@example.test`;
    const registerResponse = await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' });
    const { access_token: accessToken } =
      registerResponse.body as RegisterResponseBody;

    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('refresh with a valid refresh token rotates the pair and rejects the old refresh token afterwards', async () => {
    const email = `refresh-rotation-${Date.now()}@example.test`;
    const registerResponse = await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' });
    const { refresh_token: oldRefreshToken } =
      registerResponse.body as RegisterResponseBody;

    const refreshResponse = await request(httpServer)
      .post('/auth/refresh')
      .send({ refresh_token: oldRefreshToken });

    expect(refreshResponse.status).toBe(200);
    const { access_token: newAccessToken, refresh_token: newRefreshToken } =
      refreshResponse.body as TokenPairResponseBody;
    expect(newRefreshToken).not.toBe(oldRefreshToken);

    await request(httpServer)
      .post('/auth/refresh')
      .send({ refresh_token: oldRefreshToken })
      .expect(401);
    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${newAccessToken}`)
      .expect(200);
  });

  it('rejects a refresh token used on a domain endpoint', async () => {
    const email = `refresh-on-domain-${Date.now()}@example.test`;
    const registerResponse = await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' });
    const { refresh_token: refreshToken } =
      registerResponse.body as RegisterResponseBody;

    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${refreshToken}`)
      .expect(401);
  });

  it('rejects an access token used on the refresh endpoint', async () => {
    const email = `access-on-refresh-${Date.now()}@example.test`;
    const registerResponse = await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' });
    const { access_token: accessToken } =
      registerResponse.body as RegisterResponseBody;

    await request(httpServer)
      .post('/auth/refresh')
      .send({ refresh_token: accessToken })
      .expect(401);
  });
});
