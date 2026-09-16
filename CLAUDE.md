# CLAUDE.md

## Purpose

This file is the entry point for Claude Code when working on the **Program Capacity & Invoice Reservation** service.

Use it to:

- generate and modify code;
- make implementation decisions;
- review changes;
- identify violations of project invariants;
- choose the correct test level;
- keep documentation and implementation consistent.

This is a POC, but the code MUST be treated as production-quality code.

---

# Read First

Before making a meaningful change, read the relevant project documents.

```text
BUSINESS.md        domain model, money, FX, capacity, reservation/release, reconciliation
ARCHITECTURE.md    NestJS modules, boundaries, Kysely, Kafka abstractions, dependency direction
INFRASTRUCTURE.md  PostgreSQL/Kafka/Docker Compose, inbox/outbox, at-least-once guarantees
SECURITY.md        JWT-only authentication, registration/login/refresh, password/token rules
TESTING.md         test levels, required scenarios, real infrastructure boundaries
CODE_STYLE.md      TypeScript/NestJS conventions, naming, transactions, lint/style rules
```

Do not duplicate or replace these documents with assumptions.

---

# Rule Precedence

When rules overlap, use the document that owns the concern:

```text
business/domain semantics       → docs/spec/BUSINESS.md
authentication/security         → docs/spec/SECURITY.md
module/design structure         → docs/spec/ARCHITECTURE.md
delivery/runtime guarantees     → docs/spec/INFRASTRUCTURE.md
testing strategy                → docs/spec/TESTING.md
code/style conventions          → docs/spec/CODE_STYLE.md
```

A concern-specific invariant overrides a generic style preference.

If a requested change intentionally changes an established invariant:

1. implement the new decision consistently;
2. update every affected project document;
3. call out the architectural/business consequence in the final summary.

Do not silently resolve contradictions by inventing a third design.

---

# Project Stack

Use the established stack only:

```text
Node.js 24.x LTS
NestJS
TypeScript strict mode
PostgreSQL
Kysely
pg + pg-cursor
Kafka in KRaft mode
Axios
@nestjs/config
envalid
Passport JWT
bcrypt
Jest
Docker Compose
```

Do not introduce a second library for an already-owned concern without an intentional architecture change.

---

# Project Structure

The canonical structure is:

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

Do not introduce parallel `src/modules` or `src/libraries` trees.

Every persisted domain entity has a dedicated module with, where applicable:

```text
controller
service
repository
entity/interface
DTOs
client        only when external HTTP is owned by the module
consumer      only when Kafka input is owned by the module
```

---

# Dependency Direction

Preserve:

```text
HTTP Controller ───────┐
                       │
Kafka Consumer ────────┼──> Domain Service
                       │        ├──> Repository ──> Kysely/PostgreSQL
                       │        └──> Client ──────> Axios
                       │
                       └────────────> transactional outbox
```

Rules:

- controllers call services;
- Kafka handlers delegate to services;
- services own use cases and transaction boundaries;
- repositories own Kysely queries;
- clients own external HTTP semantics;
- domain modules do not instantiate infrastructure clients;
- do not deep-import another domain module's internals;
- repositories remain private unless a documented exception requires otherwise;
- do not use `forwardRef()` to hide circular design.

---

# Domain Essentials

USD is the canonical accounting and capacity currency.

Every persisted domain entity contains:

```text
id
createdAt
updatedAt
```

Core entities:

```text
User
Program
Invoice
Reservation
Release
Reconciliation
```

Treasury owns:

```text
Program total capacity
```

This service owns:

```text
Invoice lifecycle
Reservation lifecycle
Release lifecycle
```

Available capacity is derived:

```text
reservedCapacityUsd = SUM(active reservation converted USD amounts)
availableCapacityUsd = totalCapacityUsd - reservedCapacityUsd
```

Available capacity MUST NOT become negative.

---

# Money and FX

Use the `Money` value object from `BUSINESS.md`.

Never use JavaScript floating-point arithmetic for money or FX calculations.

Money is immutable.

Arithmetic/comparison requires compatible currencies.

For `Invoice`, `Reservation`, and `Release`, preserve both:

```text
originalMoney
convertedMoneyUsd
```

and the conversion snapshot where applicable.

Currency conversion uses Frankfurter:

```text
https://api.frankfurter.dev/v2/rate/{from}/{to}
```

Rules:

- USD → USD uses rate `1` and requires no HTTP call;
- conversion to USD is stored as historical data;
- existing conversions MUST NOT be silently revalued;
- Release restores the exact USD amount stored by Reservation;
- Release MUST NOT request a new FX rate.

---

# Reservation and Release Invariants

Creating a Reservation MUST:

```text
load Program + Invoice
convert to USD if needed
lock/serialize Program capacity update
atomically verify sufficient available capacity
create Reservation
mark Invoice RESERVED
```

The same Invoice MUST NOT have more than one active Reservation.

Concurrent requests MUST NOT oversubscribe Program capacity.

Release MUST:

```text
load active Reservation
reuse Reservation money/conversion
create Release
mark Reservation RELEASED
mark Invoice REPAID
restore exact reserved USD capacity
```

Only full release is supported.

A Reservation MUST NOT be released twice.

---

# Reconciliation

Reconciliation is authoritative only for treasury-owned Program capacity.

Bulk reconciliation contains multiple Program snapshots.

Each Program entry is processed independently and atomically.

For each Program:

```text
incoming sourceVersion <= treasuryVersion
    → ignore as stale/duplicate

incoming sourceVersion > treasuryVersion
    → replace treasury-owned totalCapacityUsd
    → update treasuryVersion
    → recalculate availability from active local Reservations
```

A valid reconciliation snapshot subsumes missing treasury capacity events up to its `sourceVersion`.

Events newer than that version are still processed normally.

Reconciliation MUST NOT delete, recreate, or overwrite local Reservation/Release history.

---

# PostgreSQL and Transactions

PostgreSQL is the transactional source of truth.

Kysely is the only application SQL access layer.

Services own business transactions.

Prefer:

```ts
return this.db.transaction().execute(async (trx) => {
  // repository calls using trx
});
```

Do not add `repository.startTrx()` abstractions.

Repositories accept the current Kysely executor/transaction when participating in a business transaction.

Capacity-affecting operations MUST serialize per Program using the established PostgreSQL row-locking strategy.

Use explicit locking methods such as:

```text
findByIdForUpdate
```

Do not hide lock behavior inside ordinary lookup methods.

Money and FX persistence uses exact PostgreSQL `NUMERIC`/decimal-safe representation.

---

# Kafka Guarantees

Kafka uses **at-least-once** delivery.

Duplicates are expected.

Consumer auto-commit MUST remain disabled.

Required processing order:

```text
Kafka message
    ↓
BEGIN PostgreSQL transaction
    ↓
inbox deduplication
    ↓
domain mutation
    ↓
outbox insert if required
    ↓
COMMIT PostgreSQL transaction
    ↓
commit Kafka offset
```

If DB commit fails:

```text
do not commit Kafka offset
```

If DB commit succeeds but Kafka offset commit fails:

```text
message may be redelivered
inbox idempotency must make redelivery safe
```

Do not weaken this behavior.

---

# Inbox / Outbox

Inbound Kafka events use a dedicated inbox/consumed-events table.

Inbox identity and domain changes MUST commit in the same DB transaction.

Outbound Kafka events caused by transactional domain changes use the transactional outbox.

Never publish a transactional event directly before DB commit.

The outbox publisher MAY publish the same event more than once.

Consumers therefore MUST remain idempotent.

---

# Kafka Module API

Kafka infrastructure is owned by:

```text
src/app/modules/broker-kafka/
```

It is registered through an async root module.

Publishing is exposed through an injectable service with:

```ts
produce(topic, message)
```

Consumption is exposed through:

```ts
@ConsumeOneMessage(...)
@ConsumeBatch(...)
```

Domain handlers MUST NOT manage raw Kafka consumer lifecycle or offsets.

For batch consumption, offsets advance per partition only through the highest contiguous successfully processed offset.

Never commit beyond a failed record in the same partition.

---

# HTTP Integrations

Axios is the only outbound HTTP client.

Do not call Axios from:

```text
controllers
repositories
entities
```

Use dedicated clients.

External responses are untrusted and must be validated/mapped before they enter domain logic.

Raw `AxiosError` MUST NOT escape the client boundary.

Use finite timeouts from validated configuration.

---

# Authentication

The only allowed authentication mechanism is JWT.

Do not add:

```text
sessions/cookies
HTTP Basic
OAuth/OIDC
API keys
Passport Local
passkeys/WebAuthn
MFA
other auth strategies
```

Route policy:

```text
POST /users/register   PUBLIC
POST /users/login      PUBLIC
POST /auth/refresh     JWT REFRESH TOKEN
domain endpoints       JWT ACCESS TOKEN
health/readiness       PUBLIC
```

All domain HTTP operations require a valid access token.

`/auth/refresh` is not public; it uses a dedicated refresh-token guard/strategy.

Controllers access the authenticated identity only with:

```ts
@CurrentUser() user: AuthenticatedUser
```

Never read `request.user` directly.

---

# Auth Architecture

Preserve:

```text
Decorator
    ↓
Guard
    ↓
Passport JWT Strategy
    ↓
Auth Service
    ↓
Identity Lookup Port
    ↓
AuthenticatedUser
    ↓
Controller
```

The Auth module MUST NOT query `UsersRepository` directly.

It uses the narrow identity lookup port implemented by the Users domain.

Registration/login orchestration is exposed through Users endpoints.

JWT issuance/verification, refresh-token rotation, and password verification remain centralized in Auth.

---

# Passwords and Tokens

Passwords use asynchronous:

```text
bcrypt.hash
bcrypt.compare
```

Never persist plaintext passwords.

Never return or log password hashes.

Access and refresh tokens:

- are different token types;
- use separate secrets/keys;
- use separate TTLs;
- verify explicit algorithm, issuer, audience, expiry, and token type.

Raw refresh tokens MUST NOT be persisted.

Refresh tokens are backed by server-side revocable state.

Successful refresh rotates the refresh token and invalidates the old one.

---

# Configuration

Use:

```text
@nestjs/config
envalid
```

Configuration lives under:

```text
src/config/
```

Application code MUST NOT read `process.env` directly.

Invalid required configuration MUST fail application startup.

Secrets MUST NOT be committed, logged, or hardcoded.

---

# Logging

Use NestJS `Logger`.

Do not introduce another logging framework for this POC.

Do not use `console.*` in normal application code.

The explicitly configured Kysely SQL logging callback is the documented exception when SQL logging is enabled.

Never log:

```text
passwords
password hashes
access tokens
refresh tokens
Authorization headers
database credentials
```

Prefer identifiers and operational context.

---

# TypeScript and Style

Use strict TypeScript.

`any` is forbidden in application code.

Use `unknown` at untrusted boundaries and narrow it.

Avoid unsafe casts and non-null assertions.

Use interfaces for domain/persistence object shapes and type aliases for unions/utility types where appropriate.

Use explicit return types on exported/public boundaries.

Use Kebab-case file names and conventional NestJS class names.

Do not create generic abstractions until concrete repetition justifies them.

Do not create generic repositories, generic event buses, base service frameworks, or plugin systems for hypothetical future needs.

Follow `CODE_STYLE.md` for detailed lint, naming, import, DTO, error, and formatting rules.

---

# Error Handling

Expected business failures use typed module-owned errors.

Examples:

```text
InsufficientCapacityError
ReservationAlreadyExistsError
ReservationNotFoundError
FxRateUnavailableError
```

Do not use bare `Error` for expected business conditions.

Translate infrastructure errors at their boundary.

Use a global exception filter for consistent HTTP mapping.

Domain errors MUST NOT be coupled directly to HTTP status codes.

---

# Tests

Follow `TESTING.md`.

Use:

```text
unit tests       business rules/value objects/orchestration
integration      PostgreSQL/Kafka/NestJS-Passport/Axios boundary behavior
E2E              small set of critical complete HTTP flows
```

Critical real-infrastructure behavior MUST NOT be proved only with mocks.

Use real PostgreSQL for:

```text
queries
constraints
transactions
row locking
concurrency
numeric precision
inbox/outbox atomicity
```

Use real Kafka for:

```text
manual offset commit
redelivery
batch behavior
at-least-once semantics
consumer registration
```

Do not call live Frankfurter in normal automated tests.

Use a controlled HTTP server for Axios/Frankfurter integration tests.

---

# Required High-Risk Tests

When affected, preserve tests for:

```text
concurrent reservations cannot oversubscribe capacity
release restores exact originally reserved USD value
duplicate Kafka event does not duplicate business effects
DB rollback removes inbox/domain/outbox writes together
DB commit + offset-commit failure is safe on redelivery
batch consumer never commits beyond failed offset in same partition
stale reconciliation cannot overwrite newer treasury state
newer reconciliation repairs earlier missing treasury events
refresh-token rotation rejects reuse
refresh token cannot access domain endpoints
access token cannot be used as refresh credential
```

---

# Working Procedure

Before coding:

1. read this file;
2. inspect the relevant module and nearby patterns;
3. read the source-of-truth document for the concern;
4. identify affected invariants;
5. choose the smallest implementation consistent with them.

While coding:

1. keep changes within the owning module where possible;
2. preserve dependency direction;
3. use existing abstractions before creating new ones;
4. preserve transaction/auth/idempotency/money guarantees;
5. add or update tests with the implementation.

Before finishing:

1. inspect the diff for accidental architectural changes;
2. verify documentation is still true;
3. run applicable checks;
4. report meaningful assumptions/trade-offs.

---

# Code Review Mode

When reviewing code, prioritize correctness over style.

Review in this order:

```text
1. Business invariants
2. Money/FX correctness
3. Concurrency and transaction correctness
4. Kafka idempotency/offset/outbox guarantees
5. Authentication/security
6. Module/dependency boundaries
7. Persistence correctness
8. Error handling
9. Test coverage
10. Type/style/readability
```

Flag issues by severity:

```text
BLOCKER   can corrupt money/capacity, break security, lose/duplicate effects
MAJOR     violates architecture/invariant or leaves important failure unsafe
MINOR     maintainability/readability/test-quality issue
```

A review finding should state:

```text
what is wrong
why it matters
which invariant/document it violates
concrete correction
```

Do not approve a change merely because happy-path tests pass.

---

# Decision Policy

For ambiguous implementation details:

1. prefer the simplest solution compatible with the documented invariants;
2. prefer PostgreSQL transactions/constraints over in-memory coordination;
3. prefer explicit code over generic frameworks;
4. prefer established project patterns over new abstractions;
5. preserve auditability for financial state;
6. preserve idempotency for any operation that may retry.

Do not expand scope unnecessarily.

This is a POC, not a platform framework.

---

# Documentation Discipline

Update documentation when a change modifies:

```text
domain semantics             → BUSINESS.md
module/dependency design     → ARCHITECTURE.md
runtime/delivery guarantees  → INFRASTRUCTURE.md
authentication/security      → SECURITY.md
testing policy               → TESTING.md
code conventions             → CODE_STYLE.md
Claude workflow/instructions → CLAUDE.md
```

Do not update documentation just to make it match an accidental implementation deviation.

Fix the code when the documentation still represents the intended design.

---

# Definition of Done

A change is complete only when applicable checks pass:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

Use the actual scripts present in the repository; do not invent dangling scripts.

Also verify:

- business invariants are preserved;
- money remains exact;
- capacity cannot be oversubscribed;
- Kafka behavior remains at-least-once and idempotent;
- transactional events use outbox;
- domain endpoints remain JWT protected;
- no unsupported authentication mechanism was added;
- no secrets or credentials are logged;
- no new circular dependencies were introduced;
- affected behavior has tests;
- intentional design changes are reflected in documentation.

---

# Non-Negotiable Summary

Never:

```text
use floating-point money arithmetic
revalue an existing Reservation/Release with a new FX rate
allow available capacity to become negative
let reconciliation overwrite local Reservation history
commit Kafka offsets before the DB transaction succeeds
apply the same Kafka event twice
publish transactional Kafka side effects before DB commit
bypass the outbox for transactional events
bypass repositories with direct domain-service SQL
call Axios outside dedicated integration clients
read request.user directly
make a domain endpoint public
introduce non-JWT authentication
store plaintext passwords or raw refresh tokens
log passwords/tokens/secrets
hide circular dependencies with forwardRef()
weaken tests/types/auth/locking for implementation convenience
```

When in doubt, preserve correctness and documented invariants over convenience.
