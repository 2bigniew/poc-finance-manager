import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@app/app.module';
import { configureApp } from '@app/configure-app';
import type { Server } from 'node:http';

interface UserResponseBody {
  id: string;
  email: string;
}

interface RegisterResponseBody {
  user: UserResponseBody;
  access_token: string;
}

// Account creation/authentication itself is covered by test/auth.e2e-spec.ts. This
// suite focuses on the CRUD surface (list/get/patch/delete), all of which now require
// a valid access token by default via the global JwtAccessGuard.
describe('Users (e2e)', () => {
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

  async function registerUser(
    email: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const response = await request(httpServer)
      .post('/users/register')
      .send({ email, password: 'password123' });
    const body = response.body as RegisterResponseBody;

    return { userId: body.user.id, accessToken: body.access_token };
  }

  it('rejects every CRUD route without a token', async () => {
    await request(httpServer).get('/users').expect(401);
    await request(httpServer)
      .get('/users/00000000-0000-0000-0000-000000000000')
      .expect(401);
    await request(httpServer)
      .patch('/users/00000000-0000-0000-0000-000000000000')
      .send({})
      .expect(401);
    await request(httpServer)
      .delete('/users/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('supports the full CRUD lifecycle with a valid access token', async () => {
    // A separate, still-valid caller performs CRUD on the subject user - deleting the
    // subject must not affect the caller's own token (SECURITY.md's POC baseline has
    // no per-resource ownership yet: any authenticated user may manage any user record).
    const { accessToken: callerToken } = await registerUser(
      `crud-caller-${Date.now()}@example.test`,
    );
    const authHeader = `Bearer ${callerToken}`;

    const subjectEmail = `crud-subject-${Date.now()}@Example.Test`;
    const { userId: subjectId } = await registerUser(subjectEmail);

    const getResponse = await request(httpServer)
      .get(`/users/${subjectId}`)
      .set('Authorization', authHeader);
    const fetched = getResponse.body as UserResponseBody;
    expect(getResponse.status).toBe(200);
    expect(fetched.email).toBe(subjectEmail.toLowerCase());
    expect(fetched).not.toHaveProperty('passwordHash');

    const listResponse = await request(httpServer)
      .get('/users')
      .set('Authorization', authHeader);
    const listed = listResponse.body as UserResponseBody[];
    expect(listResponse.status).toBe(200);
    expect(listed.map((user) => user.id)).toContain(subjectId);
    for (const user of listed) {
      expect(user).not.toHaveProperty('passwordHash');
    }

    const newEmail = `updated-${Date.now()}@example.test`;
    const updateResponse = await request(httpServer)
      .patch(`/users/${subjectId}`)
      .set('Authorization', authHeader)
      .send({ email: newEmail });
    const updated = updateResponse.body as UserResponseBody;
    expect(updateResponse.status).toBe(200);
    expect(updated.email).toBe(newEmail);
    expect(updated).not.toHaveProperty('passwordHash');

    await request(httpServer)
      .delete(`/users/${subjectId}`)
      .set('Authorization', authHeader)
      .expect(204);

    const afterDeleteResponse = await request(httpServer)
      .get(`/users/${subjectId}`)
      .set('Authorization', authHeader);
    expect(afterDeleteResponse.status).toBe(404);
  });

  it('rejects an invalid UUID path parameter', async () => {
    const { accessToken } = await registerUser(
      `invalid-uuid-${Date.now()}@example.test`,
    );

    await request(httpServer)
      .get('/users/not-a-uuid')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });
});
