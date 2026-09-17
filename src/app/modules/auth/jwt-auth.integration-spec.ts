import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@app/app.module';
import { configureApp } from '@app/configure-app';
import { AuthConfig } from '@config/auth.config';
import type { StringValue } from 'ms';
import type { Server } from 'node:http';

interface RegisterResponseBody {
  user: { id: string; email: string };
  access_token: string;
  refresh_token: string;
}

interface CurrentUserResponseBody {
  id: string;
  email: string;
  authMethod: string;
}

// Focuses on the guard/strategy WIRING itself (issuer/audience/expiry/cross-guard
// rejection) - the full register -> login -> domain-request -> refresh USER FLOWS are
// covered by test/auth.e2e-spec.ts. Both necessarily go through real HTTP + Passport +
// PostgreSQL (TESTING.md: "NestJS dependency injection, Passport/JWT wiring").
describe('JWT auth wiring (integration)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let authConfig: AuthConfig;
  let jwtService: JwtService;
  let userId: string;
  let userEmail: string;
  let validAccessToken: string;
  let validRefreshToken: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    httpServer = app.getHttpServer() as Server;

    authConfig = app.get(ConfigService).getOrThrow<AuthConfig>('auth');
    jwtService = new JwtService();

    userEmail = `jwt-wiring-${Date.now()}@example.test`;
    const registerResponse = await request(httpServer)
      .post('/users/register')
      .send({ email: userEmail, password: 'password123' });
    const registered = registerResponse.body as RegisterResponseBody;

    userId = registered.user.id;
    validAccessToken = registered.access_token;
    validRefreshToken = registered.refresh_token;
  });

  afterAll(async () => {
    await app.close();
  });

  function signAccessToken(
    overrides: {
      secret?: string;
      issuer?: string;
      audience?: string;
      expiresIn?: string;
    } = {},
  ): string {
    return jwtService.sign(
      { sub: userId, type: 'access' },
      {
        secret: overrides.secret ?? authConfig.accessTokenSecret,
        issuer: overrides.issuer ?? authConfig.issuer,
        audience: overrides.audience ?? authConfig.audience,
        algorithm: authConfig.algorithm,
        expiresIn: (overrides.expiresIn ?? '15m') as StringValue,
      },
    );
  }

  it('allows a @Public() route through the global guard without any token', async () => {
    await request(httpServer).get('/health').expect(200);
  });

  it('rejects a protected route with no token', async () => {
    await request(httpServer).get('/users').expect(401);
  });

  it('rejects an invalid/garbage token', async () => {
    await request(httpServer)
      .get('/users')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
  });

  it('rejects an expired access token', async () => {
    const expired = signAccessToken({ expiresIn: '-10s' });
    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
  });

  it('rejects a token with the wrong issuer', async () => {
    const wrongIssuer = signAccessToken({ issuer: 'someone-else' });
    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${wrongIssuer}`)
      .expect(401);
  });

  it('rejects a token with the wrong audience', async () => {
    const wrongAudience = signAccessToken({ audience: 'someone-else-clients' });
    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${wrongAudience}`)
      .expect(401);
  });

  it('accepts a valid access token and resolves the normalized AuthenticatedUser via @CurrentUser()', async () => {
    const response = await request(httpServer)
      .get('/auth/me')
      .set('Authorization', `Bearer ${validAccessToken}`)
      .expect(200);
    const body = response.body as CurrentUserResponseBody;

    expect(body).toEqual({
      id: userId,
      email: userEmail.toLowerCase(),
      authMethod: 'jwt',
    });
    expect(body).not.toHaveProperty('passwordHash');
  });

  it('rejects a refresh token presented on an access-protected route', async () => {
    await request(httpServer)
      .get('/users')
      .set('Authorization', `Bearer ${validRefreshToken}`)
      .expect(401);
  });

  it('rejects an access token presented on the refresh route', async () => {
    await request(httpServer)
      .post('/auth/refresh')
      .send({ refresh_token: validAccessToken })
      .expect(401);
  });
});
