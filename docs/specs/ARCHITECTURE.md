# Architecture

## Purpose

This document defines the application structure and implementation rules for the Program Capacity & Invoice Reservation service.

The application is built with:

```text
Node.js
NestJS
PostgreSQL + Kysely
Kafka
Axios
Passport + JWT
bcrypt
@nestjs/config + envalid
NestJS Logger
```

Business rules are defined in `BUSINESS.md`.
Infrastructure and delivery guarantees are defined in `INFRASTRUCTURE.md`.

---

# Application Structure

Use the following module layout:

```text
src/
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

Infrastructure modules MAY live directly under `src/app/modules/`.

Business/domain modules MUST live under:

```text
src/app/modules/domain/
```

---

# Domain Module Structure

Each persisted domain entity MUST have a dedicated NestJS module.

Use this structure where applicable:

```text
reservations/
├── reservations.module.ts
├── reservations.controller.ts
├── reservations.service.ts
├── reservations.repository.ts
├── reservation.entity.ts
├── dto/
└── clients/                 # only when this module owns an HTTP integration
```

Required responsibilities:

```text
Controller  -> HTTP boundary only
Service     -> application/domain orchestration and transaction boundary
Repository  -> PostgreSQL access through Kysely
Client      -> external HTTP integration, only when required
Entity      -> domain/persistence contract
```

Controllers MUST NOT access repositories, Kysely, Kafka, or Axios directly.

Repositories MUST NOT contain HTTP or Kafka concerns.

Kafka consumers MUST delegate business behavior to domain services rather than duplicate it.

Do not introduce full CRUD automatically. Each controller SHOULD expose only operations required by the business model.

---

# Dependency Direction

Preferred dependency flow:

```text
HTTP Controller ───────┐
                       │
Kafka Consumer ────────┼──> Domain Service ──> Repository ──> Kysely/PostgreSQL
                       │          │
                       │          └──> Domain/Integration Client ──> Axios
                       │
                       └──────────────────────────────> transactional outbox
```

Business services MAY depend on infrastructure through injected services or narrow interfaces.

Infrastructure MUST NOT contain business rules that belong to a domain service.

A module MUST NOT directly query another domain module's tables to bypass its public service/interface unless explicitly required by a cross-aggregate transaction.

---

# Authentication and Authorization

All business actions require authentication.

Only endpoints required to establish authentication or operate the application itself MAY be explicitly public, for example:

```text
POST /auth/login
health/readiness endpoints
```

Authentication MUST be implemented in a dedicated `auth` module using:

```text
Passport
JWT
bcrypt
```

Password hashes MUST be created and verified with bcrypt. Plain-text passwords MUST never be persisted or logged.

---

# Authentication Flow

The request authentication flow is:

```text
Auth Decorator
    ↓
Guard
    ↓
Passport Strategy
    ↓
Auth Service
    ↓
Identity Lookup Port
    ↓
AuthenticatedUser
    ↓
Controller
```

Responsibilities:

```text
Decorator
    declares authentication policy:
    - strategy
    - public/private
    - roles
    - permissions
    - MFA requirement when supported

Guard
    reads decorator metadata and enforces the policy

Passport Strategy
    extracts and verifies credentials/token

Auth Service
    resolves identity and applies account-state rules

Identity Lookup Port
    narrow interface into the Users domain

AuthenticatedUser
    normalized identity attached to the request

Controller
    reads identity only through @CurrentUser()
```

Controllers MUST NOT read `request.user` directly.

Use:

```ts
@CurrentUser() user: AuthenticatedUser
```

instead.

The Auth module MUST NOT access `UsersRepository` directly.

It MUST depend on a narrow injected identity lookup contract implemented by or delegated to the Users module.

Conceptually:

```ts
interface IdentityLookup {
  findById(id: string): Promise<UserIdentity | null>;
  findByEmail(email: string): Promise<UserIdentity | null>;
}
```

`AuthenticatedUser` is the normalized authentication contract and SHOULD contain only identity/authorization data needed by request handling.

---

# Kafka Broker Module

Kafka integration MUST be owned by:

```text
src/app/modules/broker-kafka/
```

The module MUST be configurable as an asynchronous NestJS root module:

```ts
BrokerKafkaModule.forRootAsync(...)
```

Configuration MUST come from validated application configuration.

The Kafka module owns:

```text
producer lifecycle
consumer lifecycle
consumer groups
offset management
message serialization/deserialization
consumer decorators
retry/error integration
Kafka logging
```

Domain modules MUST NOT instantiate Kafka clients directly.

---

# Kafka Producer API

The Kafka module MUST expose an injectable producer service.

Conceptually:

```ts
interface BrokerKafkaService {
  produce<T>(topic: string, message: KafkaMessage<T>): Promise<void>;
}
```

The method MUST allow sending to a specific topic and SHOULD support at least:

```text
topic
message key
payload
headers/event metadata
```

Domain code MUST inject this abstraction instead of using the underlying Kafka library directly.

Transactional business side effects MUST still follow the outbox rules from `INFRASTRUCTURE.md`.

Do not publish directly from a transaction when the event must be atomic with a PostgreSQL domain change.

---

# Kafka Consumer Decorators

The Kafka module MUST expose method decorators usable similarly to NestJS HTTP decorators:

```ts
@ConsumeOneMessage({ topic: 'treasury.capacity' })
async handle(message: KafkaMessage<CapacityEvent>) {}
```

and:

```ts
@ConsumeBatch({
  topic: 'treasury.reconciliation',
  batchSize: 100,
})
async handle(messages: KafkaMessage<ReconciliationEvent>[]) {}
```

Decorators register handlers during NestJS module discovery/bootstrap.

Domain handlers MUST NOT manage the raw Kafka consumer lifecycle themselves.

---

# Kafka Offset Rules

Kafka processing uses at-least-once delivery.

Automatic offset commits MUST be disabled.

For one-message consumption:

```text
receive message
    ↓
run handler / DB transaction
    ↓
success
    ↓
commit next offset
```

On failure:

```text
rollback / fail handler
    ↓
DO NOT commit offset
```

For batch consumption, `batchSize` MUST be configurable through `@ConsumeBatch`.

Offsets are committed per Kafka partition as a contiguous position.

Therefore:

> The consumer MUST commit only through the highest contiguous successfully processed offset for each partition.

Example:

```text
partition 0
40 success
41 success
42 failed
43 success
```

The committed position MUST NOT move past `42`.

The implementation MUST either stop/pause later processing for that partition after the first failure or otherwise guarantee that a failed message cannot be skipped by a later offset commit.

Different partitions MAY advance independently.

Inbox/idempotency, transaction boundaries, retries, and outbox behavior follow `INFRASTRUCTURE.md`.

---

# PostgreSQL / Kysely Module

Database integration MUST be owned by:

```text
src/app/modules/database/
```

Kysely is the only application SQL access layer.

Repositories MUST use injected Kysely/database abstractions and MUST NOT create independent PostgreSQL pools.

The canonical Kysely setup is:

```ts
import { CamelCasePlugin, KyselyConfig, PostgresDialect } from 'kysely';
import Cursor from 'pg-cursor';
import { Pool, types } from 'pg';
import { dbEnv } from '../config';

const logParamSerializer = (param: unknown): string => {
  if (param instanceof Date) {
    return param.toISOString();
  } else if (param === null) {
    return 'null';
  } else if (typeof param === 'string') {
    return `'${param}'`;
  } else if (typeof param === 'object') {
    return JSON.stringify(param);
  }

  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return param?.toString?.() || '';
};

const int8TypeId = 20;
types.setTypeParser(int8TypeId, (val) => {
  return parseInt(val, 10);
});

export const KYSELY_CONFIG: KyselyConfig = {
  dialect: new PostgresDialect({
    cursor: Cursor,
    pool: new Pool({
      host: dbEnv.SQL_HOST,
      port: dbEnv.SQL_PORT,
      user: dbEnv.SQL_USERNAME,
      password: dbEnv.SQL_PASSWORD,
      database: dbEnv.SQL_DBNAME,
      max: dbEnv.SQL_POOL_MAX_SIZE,
      ssl: dbEnv.SQL_USE_SSL
        ? dbEnv.SQL_CERT_PATH
          ? {
              ca: dbEnv.SQL_CERT_PATH,
              rejectUnauthorized: false,
            }
          : true
        : false,
      connectionTimeoutMillis: 10_000,
      idle_in_transaction_session_timeout: 60_000,
    }),
  }),
  log: !dbEnv.SQL_LOG
    ? undefined
    : (event) => {
        const sql = `sql: ${event.query.sql} [${event.query.parameters
          .map(logParamSerializer)
          .join(', ')}]`;
        const errorStr =
          event.level === 'error'
            ? `${event.error?.toString?.() || 'unknown error'}`
            : undefined;
        const msg = [sql, errorStr].filter(Boolean).join(', ');

        console.log(msg);
      },
  plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: false })],
};
```

Application logging SHOULD normally use NestJS `Logger`; SQL query logging MAY use the Kysely logging callback above when explicitly enabled by configuration.

Do not use PostgreSQL `int8` for values that may exceed JavaScript's safe integer range when relying on this parser.

Money and FX values MUST use exact PostgreSQL numeric types and MUST NOT be converted through JavaScript floating-point values.

---

# Database Types

Every persisted table MUST have its own TypeScript interface.

Conceptually:

```ts
interface UsersTable {}
interface ProgramsTable {}
interface InvoicesTable {}
interface ReservationsTable {}
interface ReleasesTable {}
interface ReconciliationsTable {}
interface InboxEventsTable {}
interface OutboxEventsTable {}
```

All table interfaces MUST be grouped in one Kysely `Database` interface:

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

The `CamelCasePlugin` maps application camelCase names to database snake_case names.

Table interfaces describe persistence shape. Domain entities MAY differ when persistence-specific types require mapping.

Repositories own this mapping.

---

# Database Transactions

Application/domain services own business transaction boundaries.

Repositories MUST support execution through the current Kysely transaction.

Conceptually:

```text
Service
  ↓
begin transaction
  ↓
Repository A
Repository B
Inbox/Outbox writes
  ↓
commit
```

Repositories SHOULD NOT create hidden independent transactions when participating in an existing business operation.

Capacity-affecting operations MUST preserve the per-Program locking rules from `INFRASTRUCTURE.md`.

Kafka processing MUST persist:

```text
inbox identity
+ domain mutations
+ resulting outbox events
```

in the same PostgreSQL transaction.

---

# HTTP Module and Axios

Outbound HTTP MUST use Axios.

Shared Axios construction/configuration SHOULD live in:

```text
src/app/modules/http/
```

Domain-specific HTTP semantics MUST live behind a dedicated client.

Example:

```text
ReservationService
    ↓
CurrencyExchangeService / FrankfurterClient
    ↓
shared Axios instance
    ↓
Frankfurter API
```

Controllers MUST NOT call Axios directly.

Repositories MUST NOT call Axios.

External errors MUST be mapped to application/integration errors before reaching controllers.

HTTP clients MUST use finite timeouts and configuration-provided base URLs.

---

# Configuration

Use:

```text
@nestjs/config
+
envalid
```

`@nestjs/config` owns NestJS configuration injection.

`envalid` validates and normalizes environment variables at startup.

Invalid required configuration MUST fail application startup immediately.

Configuration MUST be grouped by concern, for example:

```text
config/
├── app.config.ts
├── auth.config.ts
├── db.config.ts
├── kafka.config.ts
├── http.config.ts
└── env.ts
```

Secrets MUST NOT be hardcoded or committed to source control.

---

# Logging

Use NestJS `Logger` as the application logging abstraction.

Services, consumers, guards, clients, and infrastructure modules SHOULD create context-aware loggers.

Important logs SHOULD include identifiers when available:

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

Never log:

```text
passwords
JWT tokens
Authorization headers
private credentials
```

Raw Axios, PostgreSQL, or Kafka errors SHOULD be wrapped/mapped where appropriate while preserving useful diagnostic context.

---

# Controller Rules

Controllers are transport adapters only.

A controller MAY:

```text
read route/query/body DTOs
read @CurrentUser()
invoke a service
map/return application result
```

A controller MUST NOT:

```text
perform SQL
call Axios
use Kafka clients directly
implement capacity calculations
perform FX calculations
contain transaction logic
read request.user directly
```

All business endpoints MUST be protected by the Auth module unless explicitly marked public by policy.

---

# Service Rules

Services own application use cases and orchestration.

A service MAY:

```text
validate business preconditions
coordinate repositories
start transactions
acquire required Program locks
invoke domain/integration clients
create inbox/outbox records
call other domain services through explicit APIs
```

Business invariants from `BUSINESS.md` MUST be enforced in the service/domain layer and backed by database constraints where possible.

---

# Repository Rules

Repositories own persistence access for their module.

A repository MAY:

```text
query/update its tables
map persistence rows to domain entities
accept a transaction executor
implement locking queries
```

A repository MUST NOT:

```text
perform authentication
call external HTTP services
publish Kafka messages
contain controller concerns
silently start unrelated business transactions
```

---

# Module Summary

```text
AppModule
│
├── AuthModule
├── BrokerKafkaModule
├── DatabaseModule
├── HttpModule
│
└── Domain
    ├── UsersModule
    ├── ProgramsModule
    ├── InvoicesModule
    ├── ReservationsModule
    ├── ReleasesModule
    └── ReconciliationsModule
```

Cross-cutting value objects such as `Money` remain in the domain shared area and are not persisted through a standalone repository merely because they are reusable.

---

# Core Architecture Invariants

1. Every persisted domain entity has its own NestJS module, controller, service, repository, and entity contract.
2. Domain modules live under `src/app/modules/domain/`.
3. Infrastructure modules may live directly under `src/app/modules/`.
4. Controllers depend on services, never repositories or infrastructure clients directly.
5. Repositories are the only domain-module layer that executes Kysely queries.
6. All business HTTP actions require authentication unless explicitly declared public.
7. Controllers access identity only through `@CurrentUser()`.
8. Auth resolves Users through a narrow identity lookup port, not `UsersRepository` directly.
9. Kafka clients are owned by `BrokerKafkaModule` and injected through NestJS.
10. Kafka consumers use explicit decorators and manual offset management.
11. Batch consumers never commit beyond an unprocessed/failed offset within the same partition.
12. Kafka processing preserves inbox/idempotency and transactional outbox guarantees.
13. PostgreSQL business transactions are coordinated by services.
14. Kysely is the only SQL access layer.
15. Axios is the only outbound HTTP client and is hidden behind dedicated clients.
16. Environment configuration is loaded with `@nestjs/config` and validated with `envalid`.
17. Application logging uses NestJS `Logger`.
18. Money never uses floating-point arithmetic.

---

# Rules for AI-Generated Architecture Changes

When modifying application architecture:

1. Preserve the module boundaries and dependency direction defined here.
2. Do not move domain modules outside `src/app/modules/domain/`.
3. Do not access repositories directly from controllers, guards, or Kafka handlers.
4. Do not bypass `@CurrentUser()` with direct `request.user` access.
5. Do not make Auth depend directly on Users persistence.
6. Do not instantiate Kafka, PostgreSQL pools, or Axios clients inside domain services.
7. Preserve manual Kafka offset commits and at-least-once semantics.
8. For batches, never commit an offset beyond a failed message in the same partition.
9. Preserve Kysely as the only SQL access layer.
10. Preserve service-owned transaction boundaries and repository transaction participation.
11. Keep external HTTP behavior behind dedicated clients.
12. Validate all environment configuration at startup.
13. Use NestJS `Logger` instead of ad-hoc application logging.
14. Update this document when intentionally changing an architectural invariant.
