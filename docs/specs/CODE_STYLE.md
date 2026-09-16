# Code Style

## Purpose

This document defines code-writing conventions for the Program Capacity & Invoice Reservation service.

It complements:

- `BUSINESS.md`
- `ARCHITECTURE.md`
- `INFRASTRUCTURE.md`
- `SECURITY.md`
- `TESTING.md`

When documents overlap, domain and architectural rules from those documents take precedence over generic style preferences.

Rules use:

```text
MUST      required
SHOULD    default; deviate only with a clear reason
MAY       explicitly allowed
MUST NOT  forbidden
```

---

# Core Principles

1. Keep controllers and Kafka handlers thin.
2. Put business decisions in domain services.
3. Keep persistence inside repositories.
4. Keep external HTTP calls inside dedicated clients.
5. Prefer explicit dependencies and strong types.
6. Fail fast on invalid configuration.
7. Prefer simple code over speculative abstractions.
8. Preserve transaction, idempotency, money, and authentication invariants defined by the other project documents.

---

# Project Structure

Use the structure defined by `ARCHITECTURE.md`:

```text
src/
├── main.ts
├── app/
│   ├── app.module.ts
│   └── modules/
│       ├── auth/
│       ├── broker-kafka/
│       ├── database/
│       ├── http/
│       └── domain/
│           ├── users/
│           ├── programs/
│           ├── invoices/
│           ├── reservations/
│           ├── releases/
│           ├── reconciliations/
│           └── shared/
│               └── money/
└── config/
```

Do not introduce a parallel:

```text
src/modules/
src/libraries/
```

layout.

Infrastructure modules live directly under:

```text
src/app/modules/
```

Domain modules live under:

```text
src/app/modules/domain/
```

---

# Domain Module Structure

Every persisted domain entity MUST have its own module.

Use this shape where applicable:

```text
reservations/
├── reservations.module.ts
├── reservations.controller.ts
├── reservations.service.ts
├── reservations.repository.ts
├── reservation.entity.ts
├── reservations.consumer.ts       # only when Kafka input is owned here
├── dto/
│   ├── create-reservation.dto.ts
│   └── reservation-response.dto.ts
├── clients/                        # only when external HTTP is owned here
├── exceptions/
└── reservations.service.spec.ts
```

Do not add empty folders preemptively.

---

# Layer Responsibilities

The default dependency flow is:

```text
HTTP Controller ───────┐
                       │
Kafka Consumer ────────┼──> Domain Service
                       │        ├──> Repository ──> Kysely/PostgreSQL
                       │        └──> Client ──────> Axios
                       │
                       └────────────> transactional outbox
```

## Controller

A controller MAY:

- read validated route/query/body DTOs
- read identity through `@CurrentUser()`
- invoke a service
- return a response DTO

A controller MUST NOT:

- execute Kysely queries
- call repositories directly
- call Axios
- use Kafka clients directly
- implement capacity or FX calculations
- open transactions
- read `request.user` directly

Prefer a controller method that is one service call.

## Service

A service owns:

- application use cases
- business preconditions
- domain orchestration
- transaction boundaries
- coordination across repositories
- required Program locking
- calls to integration clients
- inbox/outbox orchestration where applicable

Services MUST NOT contain HTTP request/response concerns.

## Repository

A repository owns persistence access for its module.

Repositories MAY:

- execute Kysely queries
- map persistence rows to domain entities
- accept a Kysely transaction/executor
- implement locking queries
- map database constraint errors

Repositories MUST NOT:

- call HTTP services
- authenticate users
- publish directly to Kafka
- contain controller concerns
- silently create unrelated business transactions

Unlike a generic NestJS style guide, repositories are not optional in this project: every persisted domain entity has the repository required by `ARCHITECTURE.md`.

## Client

An external HTTP integration MUST be represented by a dedicated client.

Example:

```text
ReservationsService
    ↓
FrankfurterClient
    ↓
shared Axios instance
```

Only clients may contain domain-specific Axios request/response handling.

---

# Module Boundaries

A module owns its implementation.

Other modules MUST depend on its explicit exported service or narrow port.

Do not deep-import another module's:

- repository
- private helper
- controller
- persistence types
- internal client

Repositories SHOULD remain private providers.

Export only providers that another module actually requires.

`forwardRef()` MUST NOT be used to hide a circular design. Resolve the dependency direction instead.

---

# Authentication Boundary

Authentication lives in:

```text
src/app/modules/auth/
```

User business identity lives in:

```text
src/app/modules/domain/users/
```

The Auth module MUST use the narrow identity lookup port defined by the architecture/security documents.

It MUST NOT access `UsersRepository` directly.

Only JWT authentication is allowed.

Do not add:

```text
Basic
Session/Cookie
OAuth/OIDC
API Key
Passport Local
Passkeys
MFA
```

All domain HTTP endpoints require the JWT access-token policy.

Controllers read authenticated identity only through:

```ts
@CurrentUser() user: AuthenticatedUser
```

---

# Kafka Style

Kafka infrastructure lives in:

```text
src/app/modules/broker-kafka/
```

Domain code MUST NOT instantiate Kafka clients.

Publishing from ordinary NestJS services uses the injected broker abstraction:

```ts
await this.brokerKafkaService.produce(topic, message);
```

Transactional domain events MUST go through the outbox instead of being published directly inside a database transaction.

Kafka handlers use:

```ts
@ConsumeOneMessage(...)
```

or:

```ts
@ConsumeBatch(...)
```

The decorated handler SHOULD be thin and delegate business behavior to a domain service.

Domain handlers MUST NOT commit Kafka offsets themselves. Offset management belongs to `BrokerKafkaModule`.

---

# PostgreSQL and Kysely

Kysely is the only SQL access layer.

Do not instantiate PostgreSQL pools inside repositories or services.

Use the shared database provider from:

```text
src/app/modules/database/
```

Every table MUST have a dedicated persistence interface and all table interfaces are grouped into the shared Kysely `Database` interface.

Example:

```ts
export interface Database {
  users: UsersTable;
  programs: ProgramsTable;
  invoices: InvoicesTable;
  reservations: ReservationsTable;
  releases: ReleasesTable;
  reconciliations: ReconciliationsTable;
  inboxEvents: InboxEventsTable;
  outboxEvents: OutboxEventsTable;
}
```

Database column naming is snake_case.

Application naming is camelCase.

`CamelCasePlugin` owns the mapping.

---

# Transaction Style

Business transactions are started by services.

Prefer Kysely's callback transaction API:

```ts
return this.db.transaction().execute(async (trx) => {
  const program = await this.programsRepository.findByIdForUpdate(
    programId,
    trx,
  );

  const reservation = await this.reservationsRepository.create(
    input,
    trx,
  );

  await this.outboxRepository.create(event, trx);

  return reservation;
});
```

Throwing from the callback MUST cause the operation to fail and roll back.

Do not add `repository.startTrx()` abstractions.

Repositories should accept an executor parameter when a query can participate in a caller-owned transaction:

```ts
async findById(
  id: string,
  executor: Kysely<Database> = this.db,
): Promise<Program | null> {
  // ...
}
```

A Kysely transaction may be passed as the executor.

Use controlled/manual transactions only when callback transactions cannot express the required flow, and document why.

Repositories MUST NOT start hidden transactions for operations already inside a service transaction.

---

# Locking

Capacity-changing operations MUST use the locking strategy from `INFRASTRUCTURE.md`.

The locking query belongs in the repository and should state its intent in the method name:

```ts
findByIdForUpdate(...)
```

Do not hide locking behind a generic `findById()` method.

Concurrency behavior is a business correctness concern, not an optimization.

---

# Inbox and Outbox Style

Kafka-consuming services MUST preserve:

```text
inbox identity
+ domain mutation
+ outbox rows
```

inside the same PostgreSQL transaction.

Do not split those writes across separate transactions.

Use explicit names:

```text
InboxEventsRepository
OutboxEventsRepository
OutboxPublisherService
```

Do not call the inbox table a generic `events` table.

---

# Entities

Domain entities use interfaces unless behavior requires a class.

Example:

```ts
export interface Reservation {
  id: string;
  invoiceId: string;
  programId: string;
  originalMoney: Money;
  convertedMoneyUsd: Money;
  createdAt: Date;
  updatedAt: Date;
}
```

Every persisted domain entity MUST include:

```text
createdAt
updatedAt
```

Use `Date` in application code and timezone-aware PostgreSQL timestamps in persistence.

Do not expose raw database row types outside repositories.

---

# Persistence Types

Persistence table interfaces describe database shape, not domain behavior.

Keep them distinct from entities when needed.

Example naming:

```text
reservation.entity.ts
reservations.table.ts
database.interface.ts
```

Repositories own row-to-entity mapping.

A dedicated mapper class is OPTIONAL.

Use one only when mapping is sufficiently complex to justify it.

Do not create mapper classes for one-line property copies.

---

# Money Style

All monetary domain values MUST use the `Money` value object defined by `BUSINESS.md`.

Do not use JavaScript `number` for money arithmetic.

Bad:

```ts
const available = total - reserved;
```

Preferred:

```ts
const available = total.subtract(reserved);
```

Money operations MUST:

- preserve currency
- reject incompatible-currency arithmetic
- follow defined decimal/rounding rules
- remain immutable

Original and converted values must remain explicit.

Do not name converted values simply:

```text
amount
```

when both original and USD values exist.

Prefer names such as:

```text
originalMoney
convertedMoneyUsd
```

FX rates and PostgreSQL `NUMERIC` values MUST NOT be routed through floating-point arithmetic.

---

# DTOs and Validation

Request DTOs use `class-validator`.

The global validation pipe MUST reject unknown input:

```ts
new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  transform: true,
});
```

Required DTO fields may use definite assignment because runtime validation runs before the controller:

```ts
export class CreateReservationDto {
  @IsUUID()
  invoiceId!: string;
}
```

Do not use non-null assertions elsewhere as a general shortcut.

Response DTOs MUST expose only intended API fields.

Never return:

- password hashes
- raw refresh-token hashes
- internal inbox/outbox rows
- raw persistence records
- raw upstream HTTP payloads unless intentionally part of the API contract

---

# External HTTP and Axios

Axios is the only outbound HTTP client.

The shared Axios setup belongs in:

```text
src/app/modules/http/
```

Domain-specific request semantics belong in the owning client's module.

Example:

```ts
@Injectable()
export class FrankfurterClient {
  constructor(
    @Inject(HTTP_CLIENT)
    private readonly http: AxiosInstance,
  ) {}

  async getRate(
    from: Currency,
    to: Currency,
  ): Promise<ExchangeRate> {
    // request, validate, map
  }
}
```

External responses are untrusted input.

Map and validate them before returning domain/application values.

Raw `AxiosError` MUST NOT escape the client boundary.

Clients MUST use finite timeouts from validated configuration.

---

# Configuration

Configuration lives under:

```text
src/config/
```

Use:

```text
@nestjs/config
envalid
```

`envalid` validates and normalizes environment variables at startup.

`@nestjs/config` exposes typed configuration through NestJS DI.

Do not introduce Zod/Joi/etc. for environment validation unless the architecture is intentionally changed.

Application code MUST NOT read `process.env` directly.

Group config by concern:

```text
src/config/
├── app.config.ts
├── auth.config.ts
├── db.config.ts
├── kafka.config.ts
├── http.config.ts
└── env.ts
```

Invalid required configuration MUST fail startup.

Secrets MUST NOT be hardcoded.

---

# Logging

Use NestJS `Logger`.

Typical class style:

```ts
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
}
```

Do not introduce another logging framework for this POC.

`console.log`, `console.error`, and other `console.*` calls are forbidden in application code.

The explicit SQL logging callback in the canonical Kysely configuration MAY use `console.log` when `SQL_LOG` is enabled.

Never log:

- passwords
- password hashes
- access tokens
- refresh tokens
- Authorization headers
- database credentials
- full sensitive request bodies

Prefer identifiers and operational context:

```text
requestId
eventId
userId
programId
invoiceId
reservationId
topic
partition
offset
```

---

# Error Style

Expected business failures MUST use typed errors owned by the relevant module.

Examples:

```text
InsufficientCapacityError
ReservationAlreadyExistsError
ReservationNotFoundError
FxRateUnavailableError
```

Do not use:

```ts
throw new Error('not enough capacity');
```

for expected domain behavior.

Infrastructure-specific errors MUST be translated at their boundary:

```text
PostgreSQL constraint error → repository/application error
AxiosError                  → integration error
Kafka library error         → broker/infrastructure error
```

Controllers MUST NOT know about driver-specific errors.

Use a global exception filter for consistent HTTP error mapping.

Do not couple domain errors to HTTP status codes.

---

# TypeScript

Use strict TypeScript.

Recommended baseline:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "es2022",
    "lib": ["ES2022"],
    "strict": true,
    "useUnknownInCatchVariables": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "incremental": true,
    "baseUrl": "./",
    "outDir": "./dist"
  }
}
```

Use a separate build config that excludes tests.

---

# Type Safety

`any` is forbidden in application code.

Use `unknown` at untrusted boundaries and narrow it.

Avoid `as` assertions used only to silence the compiler.

If a type assertion is genuinely required:

1. use the narrowest possible type
2. keep it local
3. add a short comment when the reason is non-obvious

Prefer discriminated unions for variant data.

Use exhaustive switch handling for closed sets.

Mark injected dependencies and immutable value-object state `readonly`.

Public/exported functions and service methods SHOULD declare return types explicitly.

Use type-only imports when importing only a type:

```ts
import type { Transaction } from 'kysely';
```

---

# Async Style

Always handle promises.

Do not leave floating promises.

Prefer:

```ts
return this.service.execute();
```

over:

```ts
return await this.service.execute();
```

unless `await` is required for:

- local error handling
- `try/catch`
- `finally`
- sequencing
- clearer control flow

Do not use fire-and-forget work for business-critical side effects.

Use the outbox for transactional asynchronous delivery.

---

# Naming

Use:

```text
files/directories     kebab-case
classes/interfaces    PascalCase
methods/variables     camelCase
constants             UPPER_SNAKE_CASE when module-level constants
```

Do not prefix interfaces with `I`.

Prefer meaningful booleans:

```text
isActive
hasCapacity
canReserve
shouldRetry
```

Avoid vague names:

```text
data
item
obj
manager
helper
utils
```

unless the scope makes the meaning unambiguous.

---

# File Naming

| Kind | Pattern | Example |
|---|---|---|
| Module | `<name>.module.ts` | `reservations.module.ts` |
| Controller | `<name>.controller.ts` | `reservations.controller.ts` |
| Service | `<name>.service.ts` | `reservations.service.ts` |
| Repository | `<name>.repository.ts` | `reservations.repository.ts` |
| Entity | `<name>.entity.ts` | `reservation.entity.ts` |
| Table interface | `<name>.table.ts` | `reservations.table.ts` |
| Consumer | `<name>.consumer.ts` | `reconciliations.consumer.ts` |
| Client | `<provider>.client.ts` | `frankfurter.client.ts` |
| Request DTO | `<action>-<name>.dto.ts` | `create-reservation.dto.ts` |
| Response DTO | `<name>-response.dto.ts` | `reservation-response.dto.ts` |
| Error | `<name>.error.ts` | `insufficient-capacity.error.ts` |
| Guard | `<name>.guard.ts` | `jwt-access.guard.ts` |
| Strategy | `<name>.strategy.ts` | `jwt-access.strategy.ts` |
| Decorator | `<name>.decorator.ts` | `current-user.decorator.ts` |
| Test | `<name>.spec.ts` | `reservations.service.spec.ts` |
| Integration test | `<name>.integration-spec.ts` | `reservations.repository.integration-spec.ts` |
| E2E test | `<name>.e2e-spec.ts` | `reservations.e2e-spec.ts` |

---

# Imports

Relative imports are fine within one module subtree.

Cross-module imports SHOULD use configured path aliases.

Do not import via literal paths such as:

```ts
import { X } from 'src/app/...';
```

Do not use long cross-module relative paths:

```ts
import { X } from '../../../../other-module/internal';
```

Avoid root `index.ts` barrels that re-export an entire module.

Prefer explicit import origins so dependency direction remains visible.

---

# Comments

Comments explain **why**, not what the code already says.

Bad:

```ts
// increment attempts
attempts += 1;
```

Useful:

```ts
// Keep the row unpublished so at-least-once outbox retry remains possible.
```

Do not leave commented-out code.

TODOs SHOULD describe a concrete missing decision/work item rather than vague future cleanup.

---

# Functions and Methods

Prefer small functions with one responsibility.

Use guard clauses over deep nesting.

Preferred:

```ts
if (!program) {
  throw new ProgramNotFoundError(programId);
}

if (!program.availableCapacity.isGreaterThanOrEqual(amount)) {
  throw new InsufficientCapacityError(programId);
}
```

Avoid:

```ts
if (program) {
  if (program.availableCapacity.isGreaterThanOrEqual(amount)) {
    // deeply nested business logic
  }
}
```

Private assertion helpers MAY be used when they improve readability:

```text
assertSufficientCapacity
findProgramOrFail
assertReservationActive
```

Do not extract one-line helpers merely to reduce method length.

---

# Classes and Abstractions

Use dependency injection through constructors.

Do not instantiate services, repositories, Kafka clients, Axios clients, or database connections with `new` inside business code.

Do not add:

- generic repository frameworks
- generic event buses
- base service classes
- plugin systems
- abstract factories

unless at least two concrete cases demonstrate the abstraction is useful.

The project is a POC. Prefer obvious code over framework-building.

---

# ESLint

Use ESLint flat configuration with typed `typescript-eslint` rules.

Typed linting SHOULD use TypeScript's project service.

A suitable baseline is:

```js
// eslint.config.mjs
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/**', 'coverage/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': 'off',

      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['src/*'],
              message: 'Use configured path aliases for cross-module imports.',
            },
          ],
        },
      ],

      'import/order': [
        'warn',
        {
          groups: [
            ['builtin', 'external'],
            ['internal', 'parent', 'sibling', 'index', 'type'],
          ],
          'newlines-between': 'never',
        },
      ],
    },
  },
);
```

Do not disable type-aware correctness rules globally to make code pass.

A one-line lint suppression is allowed only when the rule is genuinely wrong for that line and the reason is documented.

---

# Prettier

Prettier owns formatting.

Keep configuration small:

```json
{
  "singleQuote": true,
  "trailingComma": "all"
}
```

ESLint owns correctness/import hygiene.

Do not duplicate Prettier formatting rules in ESLint.

Required scripts SHOULD include:

```text
format
format:check
lint
typecheck
```

A pre-commit formatter/linter MAY be added, but it is not required for this POC.

---

# Node.js

Use Node.js 24.x LTS for this project.

Keep local development, CI, and Docker on the same Node major.

Pin the intended major using:

```text
.nvmrc
package.json engines
Docker base image
```

Changing the Node major version is an intentional project-wide update.

---

# Testing Style

Follow `TESTING.md`.

Default rules:

- unit tests are colocated with the code they verify
- integration tests use real PostgreSQL/Kafka when their behavior is being proven
- app-wide E2E infrastructure MAY live under a top-level `test/` directory
- test names describe behavior
- use deterministic fixtures
- no live Frankfurter dependency in normal tests
- no arbitrary sleeps
- no private-method testing
- no mocking away PostgreSQL locking/Kafka offset behavior

Do not duplicate the full testing standard here.

---

# Security Style

Follow `SECURITY.md`.

In particular:

- JWT is the only authentication mechanism
- every domain route requires an access token
- registration/login are explicitly public
- refresh uses the dedicated refresh-token guard/strategy
- passwords use asynchronous bcrypt APIs
- tokens/passwords/hashes are never logged
- controllers use `@CurrentUser()`

Do not introduce alternative auth patterns through “temporary” code.

---

# Dependency Management

Use one library per concern:

```text
SQL              Kysely
PostgreSQL       pg
HTTP             Axios
config injection @nestjs/config
env validation   envalid
auth             Passport + JWT
password hashing bcrypt
tests            Jest
```

Do not add another library for an already-owned concern without changing the architecture intentionally.

Runtime dependencies belong in `dependencies`.

Build/test/lint/type packages belong in `devDependencies`.

Commit the lockfile.

Use deterministic installs:

```text
npm ci
```

in CI and Docker.

---

# Anti-Patterns

Do not introduce:

- business logic in controllers
- SQL outside repositories/database infrastructure
- direct Axios calls outside integration clients
- direct Kafka client usage in domain modules
- direct `request.user` access
- unsupported authentication mechanisms
- JavaScript floating-point money arithmetic
- hidden repository transactions
- Kafka publish-before-DB-commit for transactional events
- consumer auto-commit for business consumers
- raw driver/Axios/Kafka errors leaking to controllers
- `any` as an escape hatch
- broad unsafe `as` casts
- direct `process.env` reads in application code
- `console.*` in ordinary application code
- circular NestJS module dependencies
- `forwardRef()` as a shortcut around poor dependency direction
- giant `common`, `utils`, or `helpers` dumping grounds
- speculative generic frameworks
- deep cross-module imports
- raw DB rows returned from controllers
- plaintext passwords
- secrets or `.env` files committed to source control

---

# Rules for AI-Generated Changes

When generating or modifying code:

1. Read the owning module before adding a new pattern.
2. Follow `ARCHITECTURE.md` for dependency direction.
3. Follow `BUSINESS.md` for invariants.
4. Follow `INFRASTRUCTURE.md` for transaction/Kafka guarantees.
5. Follow `SECURITY.md` for JWT behavior.
6. Follow `TESTING.md` for test level and infrastructure.
7. Keep changes inside the owning module where possible.
8. Do not invent a new abstraction when an existing one fits.
9. Do not bypass repositories from controllers/services with direct Kysely queries.
10. Do not bypass clients with direct Axios calls.
11. Do not bypass the outbox for transactional Kafka side effects.
12. Do not weaken types, validation, locking, or authentication to make code simpler.
13. Do not add unsupported auth mechanisms.
14. Add or update tests for changed behavior.
15. Run formatting, linting, type checking, tests, and build before declaring completion.

---

# Definition of Done

A code change is complete only when applicable checks pass:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

Use the actual scripts present in the repository.

Additionally:

- no new unexplained TypeScript/ESLint suppressions
- no new circular dependency
- no secret/token/password logging
- correct module ownership
- correct transaction ownership
- correct authentication policy
- tests added for changed behavior
- money remains exact
- Kafka delivery semantics remain at-least-once and idempotent

---

# Final Rule

Prefer code that makes the domain and failure semantics obvious.

```text
Controller/Consumer
    ↓
Service
    ↓
Repository / Client
    ↓
PostgreSQL / Axios

Transactional event
    ↓
Outbox
    ↓
Kafka

Incoming Kafka event
    ↓
Inbox + domain mutation + outbox
    ↓
one PostgreSQL transaction
```

Do not hide these boundaries behind generic abstractions.
