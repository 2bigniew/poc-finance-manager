import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { version } from '../../package.json';
import { ACCESS_TOKEN_SECURITY_SCHEME } from './modules/auth/decorators/api-access-token-auth.decorator';

export const SWAGGER_UI_PATH = 'docs';
export const OPENAPI_JSON_PATH = 'docs-json';

const API_DESCRIPTION = `
Manages financing **Program** capacity and the **Invoice -> Reservation -> Release** lifecycle.

- **Capacity** is accounted in USD. \`reservedCapacityUsd\` and \`availableCapacityUsd\` are derived from ACTIVE Reservations on every read.
- **Money** is \`{ "amount": "<decimal string>", "currency": "<ISO-4217>" }\`. Amounts are strings, never JSON numbers, to keep exact precision.
- **FX**: a non-USD Invoice is converted to USD once at creation (Frankfurter) and that snapshot is stored. Reservations reuse it, and Releases restore exactly the Reservation's stored USD amount, with no revaluation.
- **Treasury reconciliation** (authoritative Program total capacity) arrives **only via Kafka** on the \`treasury.reconciliation\` topic. It has no REST endpoint and cannot be triggered from this UI.

**Authentication:** call \`POST /users/register\` or \`POST /users/login\`, then use **Authorize** with the returned \`access_token\` for domain endpoints. \`POST /auth/refresh\` takes the \`refresh_token\` in the JSON body; access and refresh tokens are not interchangeable.
`.trim();

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Program Capacity & Invoice Reservation API')
    .setDescription(API_DESCRIPTION)
    .setVersion(version)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access JWT from register/login/refresh (`access_token`). Refresh tokens are rejected here.',
      },
      ACCESS_TOKEN_SECURITY_SCHEME,
    )
    .addTag('Health', 'Liveness and readiness probes (public)')
    .addTag('Authentication', 'Registration, login, token refresh, identity')
    .addTag('Users', 'User administration')
    .addTag('Programs', 'Financing Programs and their derived USD capacity')
    .addTag('Invoices', 'Invoices with their stored FX snapshot')
    .addTag(
      'Reservations',
      'Reserving Invoice amounts against Program capacity',
    )
    .addTag('Releases', 'Releasing (repaying) Reservations')
    .build();

  return SwaggerModule.createDocument(app, config);
}

// Documentation only: serves Swagger UI at /docs and the same generated document as JSON
// at /docs-json. These routes are served outside Nest's controller pipeline, so the
// global JwtAccessGuard does not apply to them; the API routes they describe are
// unaffected.
export function configureSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(SWAGGER_UI_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    raw: ['json'],
  });
  return document;
}
