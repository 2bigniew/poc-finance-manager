import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@app/app.module';
import { configureApp } from '@app/configure-app';
import { configureSwagger } from '@app/configure-swagger';
import type { Server } from 'node:http';

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

interface DocumentedOperation {
  key: string;
  method: HttpMethod;
  path: string;
  operationId: string | undefined;
  security: unknown;
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'patch', 'delete'];

// The complete implemented REST surface. Asserting equality (not inclusion) means a new
// controller route cannot silently go undocumented and no nonexistent route can appear.
const EXPECTED_OPERATIONS = [
  'get /health',
  'get /readiness',
  'post /users/register',
  'post /users/login',
  'post /auth/refresh',
  'get /auth/me',
  'get /users',
  'get /users/{id}',
  'patch /users/{id}',
  'delete /users/{id}',
  'post /programs',
  'get /programs',
  'get /programs/{id}',
  'patch /programs/{id}',
  'delete /programs/{id}',
  'post /invoices',
  'get /invoices',
  'get /invoices/{id}',
  'post /programs/{programId}/reservations',
  'get /reservations/{id}',
  'post /reservations/{reservationId}/release',
  'get /releases/{id}',
];

// Routes that are reachable without an access token at runtime (@Public() or, for
// refresh, the dedicated refresh-token guard).
const OPERATIONS_WITHOUT_ACCESS_TOKEN = [
  'get /health',
  'get /readiness',
  'post /users/register',
  'post /users/login',
  'post /auth/refresh',
];

function operationsOf(document: OpenAPIObject): DocumentedOperation[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method] !== undefined).map(
      (method) => ({
        key: `${method} ${path}`,
        method,
        path,
        operationId: item[method]?.operationId,
        security: item[method]?.security,
      }),
    ),
  );
}

function schemaProperties(
  document: OpenAPIObject,
  name: string,
): Record<string, Record<string, unknown>> {
  const schema = document.components?.schemas?.[name];
  expect(schema).toBeDefined();
  return (schema as { properties: Record<string, Record<string, unknown>> })
    .properties;
}

describe('OpenAPI / Swagger (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    document = configureSwagger(app);
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Swagger UI at /docs without authentication', async () => {
    const response = await request(httpServer).get('/docs').expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('swagger-ui');
  });

  it('serves the same generated document as JSON at /docs-json', async () => {
    const response = await request(httpServer).get('/docs-json').expect(200);

    expect(response.body).toEqual(JSON.parse(JSON.stringify(document)));
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe(
      'Program Capacity & Invoice Reservation API',
    );
  });

  it('documents exactly the implemented REST operations', () => {
    const keys = operationsOf(document).map((operation) => operation.key);

    expect([...keys].sort()).toEqual([...EXPECTED_OPERATIONS].sort());
    expect(keys.some((key) => /reconcil|outbox|kafka/i.test(key))).toBe(false);
  });

  it('gives every operation a unique, explicit operationId', () => {
    const ids = operationsOf(document).map(
      (operation) => operation.operationId,
    );

    expect(ids.every((id) => typeof id === 'string' && !id.includes('_'))).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines the access-token bearer security scheme', () => {
    expect(document.components?.securitySchemes?.['access-token']).toEqual(
      expect.objectContaining({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      }),
    );
  });

  it('requires the access token exactly on non-public operations', () => {
    for (const operation of operationsOf(document)) {
      if (OPERATIONS_WITHOUT_ACCESS_TOKEN.includes(operation.key)) {
        expect({ key: operation.key, security: operation.security }).toEqual({
          key: operation.key,
          security: undefined,
        });
      } else {
        expect({ key: operation.key, security: operation.security }).toEqual({
          key: operation.key,
          security: [{ 'access-token': [] }],
        });
      }
    }
  });

  it('matches runtime auth: every documented protected operation rejects anonymous calls', async () => {
    const placeholderId = '550e8400-e29b-41d4-a716-446655440000';
    const protectedOperations = operationsOf(document).filter(
      (operation) => !OPERATIONS_WITHOUT_ACCESS_TOKEN.includes(operation.key),
    );

    for (const operation of protectedOperations) {
      const path = operation.path.replace(/\{[^}]+\}/g, placeholderId);
      const response = await request(httpServer)[operation.method](path);
      expect({ key: operation.key, status: response.status }).toEqual({
        key: operation.key,
        status: 401,
      });
    }
  });

  it('documents the refresh token as a request-body field, not a bearer token', () => {
    const refresh = document.paths['/auth/refresh']?.post;
    const body = refresh?.requestBody as
      { content: Record<string, { schema: { $ref: string } }> } | undefined;

    expect(body?.content['application/json']?.schema.$ref).toBe(
      '#/components/schemas/RefreshTokenRequestDto',
    );
    expect(
      Object.keys(schemaProperties(document, 'RefreshTokenRequestDto')),
    ).toEqual(['refresh_token']);
  });

  it('documents UUID path parameters with format uuid', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of HTTP_METHODS) {
        for (const parameter of item[method]?.parameters ?? []) {
          if ('in' in parameter && parameter.in === 'path') {
            expect({
              path,
              name: parameter.name,
              schema: parameter.schema,
            }).toEqual({
              path,
              name: parameter.name,
              schema: expect.objectContaining({
                type: 'string',
                format: 'uuid',
              }) as unknown,
            });
          }
        }
      }
    }
  });

  it('exposes key request/response schemas with decimal-string money', () => {
    for (const name of [
      'CreateInvoiceDto',
      'InvoiceResponseDto',
      'CreateReservationDto',
      'ReservationResponseDto',
      'ReleaseResponseDto',
      'ProgramResponseDto',
      'ErrorResponseDto',
    ]) {
      expect(document.components?.schemas?.[name]).toBeDefined();
    }

    expect(schemaProperties(document, 'MoneyDto').amount).toEqual(
      expect.objectContaining({ type: 'string' }),
    );
    expect(schemaProperties(document, 'CreateInvoiceDto').amount).toEqual(
      expect.objectContaining({ type: 'string', pattern: '^\\d+(\\.\\d+)?$' }),
    );
    expect(
      schemaProperties(document, 'CreateReservationDto').invoiceId,
    ).toEqual(expect.objectContaining({ type: 'string', format: 'uuid' }));
    expect(schemaProperties(document, 'InvoiceResponseDto').status).toEqual(
      expect.objectContaining({
        allOf: [{ $ref: '#/components/schemas/InvoiceStatus' }],
      }),
    );
    expect(document.components?.schemas?.InvoiceStatus).toEqual(
      expect.objectContaining({ enum: ['OPEN', 'RESERVED', 'REPAID'] }),
    );
    expect(Object.keys(schemaProperties(document, 'CreateProgramDto'))).toEqual(
      [
        'name',
        'originalCapacityAmount',
        'originalCapacityCurrency',
        'totalCapacityUsdAmount',
      ],
    );
  });

  it('never exposes credential or persistence internals', () => {
    const serialized = JSON.stringify(document);

    expect(serialized).not.toMatch(/passwordHash|password_hash|tokenHash/i);
    expect(Object.keys(schemaProperties(document, 'UserResponseDto'))).toEqual([
      'id',
      'email',
      'createdAt',
      'updatedAt',
    ]);
  });
});
