# Testing Standard

## Purpose

This document defines the testing standard for the Program Capacity & Invoice Reservation service.

It complements:

- `BUSINESS.md`
- `ARCHITECTURE.md`
- `INFRASTRUCTURE.md`
- `SECURITY.md`

The application stack is:

```text
Node.js
NestJS
Jest
PostgreSQL
Kysely
Kafka
Axios
Passport + JWT
bcrypt
Docker Compose
```

Tests MUST provide confidence in:

- business invariants
- money and currency conversion
- PostgreSQL persistence and transaction behavior
- concurrency and capacity protection
- Kafka at-least-once consumption
- inbox/idempotency behavior
- transactional outbox behavior
- reconciliation
- JWT authentication
- external HTTP integration

---

# Testing Layers

Use three test layers:

```text
Unit
Integration
E2E
```

Prefer:

```text
many focused unit tests
        ↓
fewer integration tests
        ↓
small number of critical E2E flows
```

Use the cheapest test that proves the behavior.

---

# Test Framework

Use:

```text
Jest
@nestjs/testing
```

Do not introduce another test runner without an explicit architectural decision.

Recommended naming:

```text
*.spec.ts
*.integration-spec.ts
*.e2e-spec.ts
```

Tests SHOULD live close to the code they verify.

---

# Unit Tests

Unit tests validate business behavior without external infrastructure.

Mock or fake architectural boundaries such as:

```text
Repository
Kafka broker service
HTTP client
Identity lookup
Clock
UUID generator
```

Unit tests MUST NOT:

- start PostgreSQL
- start Kafka
- call the live Frankfurter API
- test NestJS, Axios, bcrypt, Passport, Kysely, or Kafka library internals

Prefer observable results over assertions about private method calls.

---

# Integration Tests

Integration tests validate behavior that depends on real framework or infrastructure semantics.

Use real integration infrastructure for:

```text
PostgreSQL
Kafka
NestJS dependency injection
Passport/JWT wiring
Axios HTTP behavior
```

Docker Compose SHOULD provide isolated test infrastructure.

Integration tests MUST NOT use developer or production databases/topics.

---

# E2E Tests

E2E tests validate complete critical application flows through HTTP.

Keep the E2E suite small.

At minimum cover:

```text
register → login → authenticated domain request
create reservation → capacity decreases
release reservation → capacity returns
refresh token → new token pair
```

Do not duplicate every service branch at E2E level.

---

# General Test Rules

Tests MUST be:

- deterministic
- isolated
- independent of execution order
- safe to run repeatedly
- explicit about expected business behavior

Use Arrange / Act / Assert where useful.

Test names SHOULD describe:

```text
condition + expected behavior
```

Good:

```text
rejects reservation when available capacity is insufficient
ignores duplicate treasury event
releases the exact USD amount reserved originally
rejects refresh token on a domain endpoint
```

Avoid:

```text
works
service test
calls repository
```

---

# Time and IDs

Do not rely on sleeps.

Use:

- fixed timestamps
- fake timers
- injected clocks where useful
- deterministic UUIDs where useful

All entities contain:

```text
createdAt
updatedAt
```

Tests SHOULD verify timestamp behavior where creation/update semantics matter.

Do not snapshot random UUIDs or wall-clock timestamps.

---

# Money Tests

`Money` is a value object and MUST have focused unit coverage.

Test at minimum:

```text
creation with valid amount/currency
decimal-safe arithmetic
addition of same currency
subtraction of same currency
comparison
zero values
negative-value rules where applicable
currency mismatch rejection
rounding according to currency precision
immutability
```

Money calculations MUST NOT rely on JavaScript floating-point arithmetic.

Tests SHOULD use values that expose floating-point errors, for example:

```text
0.1 + 0.2
```

and verify exact domain behavior.

---

# Currency Conversion Tests

USD is the canonical application currency.

Invoice, Reservation, and Release preserve:

```text
originalMoney
convertedMoneyUsd
```

Unit tests MUST verify:

- USD input does not require FX conversion
- non-USD input is converted to USD
- original amount/currency remain unchanged
- converted USD amount is persisted separately
- the FX rate used for reservation is stable historical data
- release does not fetch a new FX rate
- release restores the exact USD amount recorded by the reservation

Example:

```text
Invoice:       EUR 100
Reservation:   original EUR 100
               converted USD 110

Later FX changes.

Release:       original EUR 100
               converted USD 110
```

The release MUST NOT become USD 105 or USD 115.

---

# Frankfurter HTTP Client Tests

Normal automated tests MUST NOT call the live Frankfurter service.

Unit tests MAY mock the client boundary.

HTTP integration tests SHOULD use a controlled local HTTP server and exercise the real Axios client configuration.

Verify:

```text
base URL
request path
source currency
target USD currency
response mapping
timeout
4xx mapping
5xx mapping
malformed response handling
network failure
```

Do not expose `AxiosError` outside the integration client boundary.

Optional live Frankfurter smoke tests MAY exist under an explicit opt-in command such as:

```text
test:external
```

They MUST NOT run in the normal CI test suite.

---

# User Tests

The Users module owns account data.

Unit tests SHOULD cover:

```text
account creation
email validation
email uniqueness behavior
password hashing request
plaintext password is never persisted
createdAt/updatedAt
identity lookup by id
identity lookup by email
```

Repository integration tests SHOULD verify:

```text
insert
find by id
find by email
unique email constraint
update
timestamp persistence
database error mapping
```

---

# Authentication Tests

The only allowed authentication mechanism is JWT.

Supported flows:

```text
POST /users/register
POST /users/login
POST /auth/refresh
Authorization: Bearer <access_token>
```

No tests SHOULD introduce or enable:

```text
Session
Cookie authentication
HTTP Basic
OAuth/OIDC
API Key
Passkeys
MFA
Passport Local strategy
```

Login may validate email/password directly through the Auth service and bcrypt.

---

# JWT Unit Tests

Test application-owned JWT behavior.

Access token cases:

```text
valid payload
expired token
invalid signature
wrong issuer
wrong audience
wrong token type
missing user
inactive user where supported
mapping to AuthenticatedUser
```

Refresh token cases:

```text
valid refresh token
expired refresh token
invalid signature
wrong token type
revoked token
rotated token reuse
missing stored token
```

Do not re-test Passport or JWT library internals.

---

# JWT Integration Tests

Use real NestJS + Passport wiring.

Verify:

```text
missing access token → 401
invalid access token → 401
expired access token → 401
valid access token → request succeeds
refresh token on domain endpoint → 401
access token on refresh endpoint → 401
valid refresh token → new token pair
@CurrentUser() receives normalized identity
```

Every domain controller MUST reject unauthenticated access.

Registration and login are public.

`/auth/refresh` is protected by the dedicated refresh-token strategy/guard, not by the access-token guard.

Health/readiness endpoints MAY remain public.

---

# Password Tests

Use fake passwords only.

Verify:

- bcrypt hashing is used
- plaintext password is not persisted
- correct password succeeds
- incorrect password fails
- password hash is never returned in API responses

Do not assert exact bcrypt hashes because salts make them nondeterministic.

Do not test bcrypt itself.

---

# Program Tests

Program service unit tests SHOULD cover:

```text
create/update according to business rules
USD capacity
available capacity calculation
reserved capacity calculation
timestamps
invalid capacity
```

Repository integration tests SHOULD verify persistence and row-locking behavior used by capacity-changing transactions.

---

# Invoice Tests

Invoice tests SHOULD cover:

```text
original amount and currency preserved
converted USD amount preserved
USD invoice requires no FX request
non-USD invoice uses FX conversion
timestamps
relationship to program
invalid amount/currency
```

If invoice creation triggers conversion, external FX behavior MUST be mocked in unit tests and covered separately in HTTP integration tests.

---

# Reservation Tests

Reservation service unit tests MUST cover:

```text
successful reservation
insufficient available capacity
reservation amount equals available capacity
duplicate reservation for the same invoice
original amount/currency preserved
converted USD amount preserved
capacity consumed in USD
timestamps
```

Important invariant:

```text
reserved capacity MUST NOT exceed total capacity
```

---

# Reservation Concurrency Tests

The oversubscription invariant MUST be proven with PostgreSQL integration tests.

Example:

```text
available capacity = USD 100

request A reserves USD 80
request B reserves USD 80
```

When executed concurrently:

```text
exactly one succeeds
the other fails with insufficient capacity
final reserved capacity = USD 80
final available capacity = USD 20
```

The test MUST exercise the real transaction/locking implementation.

Do not prove this only with mocks.

---

# Release Tests

Release service unit tests MUST cover:

```text
successful release
release of missing reservation
release of already released reservation
original money preserved
converted USD money preserved
exact reservation USD amount restored
timestamps
```

Release MUST be idempotent according to the business rule chosen in `BUSINESS.md`.

A release MUST NOT perform a fresh FX conversion.

---

# Reconciliation Tests

Reconciliation unit tests SHOULD cover:

```text
newer snapshot updates treasury-owned capacity
older snapshot is ignored
duplicate snapshot is ignored
snapshot version is stored
missing earlier treasury events are subsumed by a newer authoritative snapshot
local reservation history is not overwritten
available capacity is recalculated correctly
USD is assumed for reconciliation values
```

If reconciliation contains multiple programs, test:

```text
one program succeeds independently
another program fails independently
successful programs remain committed
failed program can be retried
```

unless the business specification explicitly requires whole-batch atomicity.

---

# Treasury Event Version Tests

Where events use a per-program sequence/version, test:

```text
expected next version is applied
duplicate version is ignored
older version is ignored
gap is detected
newer reconciliation repairs the gap
```

Do not rely only on Kafka ordering to guarantee correctness.

---

# PostgreSQL Repository Integration Tests

Repository integration tests MUST use real PostgreSQL.

Do not use an in-memory SQL replacement as the only persistence proof.

Verify where applicable:

```text
insert
read
update
constraints
unique indexes
foreign keys
transactions
rollback
row locking
numeric precision
timestamps
JSON/event payload persistence
```

Money-related DB columns MUST preserve exact decimal values.

---

# Kysely Tests

Do not unit test Kysely itself.

Repository integration tests SHOULD prove that application queries work with the configured:

```text
PostgresDialect
CamelCasePlugin
pg
pg-cursor
```

Important mappings include:

```text
database snake_case ↔ TypeScript camelCase
int8 parsing
numeric/decimal handling
timestamp mapping
```

If cursor-based reads are used, cover their repository behavior with real PostgreSQL.

---

# Database Isolation

Every integration test MUST begin from predictable state.

Preferred approaches:

- dedicated test PostgreSQL database
- schema cleanup between suites
- transaction rollback where compatible with the behavior under test
- unique test identifiers

Do not depend on test execution order.

Concurrency tests SHOULD use independently committed transactions and MUST NOT be wrapped in one shared rollback transaction that hides locking behavior.

---

# Kafka Unit Tests

Business services SHOULD NOT require Kafka to run in unit tests.

Mock the broker abstraction when testing services that publish events.

Verify business intent, for example:

```text
successful reservation records/publishes expected domain event
failed transaction produces no event
```

Prefer testing the transactional outbox record rather than only verifying that `produce()` was called.

---

# Kafka Integration Tests

Use a real Kafka broker in KRaft mode for Kafka-specific integration behavior.

Test infrastructure SHOULD match `INFRASTRUCTURE.md`.

Verify:

```text
consumer receives message
handler succeeds → offset advances
handler fails → failed offset is not committed
consumer restart redelivers uncommitted message
duplicate delivery is harmless
batch size configuration is respected
```

Do not depend on arbitrary `setTimeout` sleeps.

Use explicit polling helpers with bounded timeouts.

---

# @ConsumeOneMessage Tests

Integration tests SHOULD verify:

```text
decorated handler is registered
one message is passed to the handler
success commits the offset
failure does not commit the offset
redelivery occurs after restart/retry
```

The test should validate observable broker behavior, not decorator implementation details.

---

# @ConsumeBatch Tests

Batch integration tests MUST respect Kafka offset semantics.

Offsets are committed per partition as a contiguous position.

Example:

```text
partition 0:

offset 40 → success
offset 41 → success
offset 42 → failure
offset 43 → success
```

The consumer MUST NOT commit beyond the failed offset.

For that partition, the committed position may advance only through the highest contiguous successfully processed offset.

Test:

```text
batch size passed to decorator
multiple partitions
partial success
failure in the middle of one partition
successful progress in another partition
redelivery of uncommitted records
```

Never design a test that assumes Kafka can independently commit arbitrary individual offsets within the same partition.

---

# Inbox / Idempotent Consumer Tests

Consumed Kafka events MUST be idempotent.

Use a dedicated consumed-events/inbox table.

Integration tests MUST verify:

```text
first delivery applies business change
event id is recorded
duplicate delivery does not apply business change again
duplicate delivery completes safely
```

The inbox write and domain mutation MUST occur in the same PostgreSQL transaction.

Failure test:

```text
inbox insert succeeds
domain mutation fails
```

MUST result in:

```text
whole transaction rolled back
event remains retryable
```

There MUST NOT be a persisted inbox record for a business change that did not commit.

---

# Transactional Outbox Tests

Outbox integration tests MUST verify atomicity.

Success:

```text
BEGIN
domain change
outbox insert
COMMIT
```

Both MUST be visible after commit.

Failure:

```text
BEGIN
domain change
outbox insert
error
ROLLBACK
```

Neither MUST remain persisted.

Also test publisher behavior:

```text
unpublished row is published to Kafka
row is marked published after successful produce
Kafka failure leaves row unpublished
publisher can retry
```

At-least-once publishing means the same outbox message MAY be published more than once.

Consumers MUST therefore remain idempotent.

---

# Kafka Consumer Transaction Tests

For an incoming treasury event, integration tests SHOULD prove the intended flow:

```text
Kafka message
    ↓
BEGIN PostgreSQL transaction
    ↓
deduplicate via inbox
    ↓
apply domain/reconciliation changes
    ↓
insert outbox events if required
    ↓
COMMIT
    ↓
commit Kafka offset
```

If PostgreSQL commit fails:

```text
Kafka offset MUST NOT be committed
```

If offset commit fails after the PostgreSQL transaction committed:

```text
message may be delivered again
inbox deduplication MUST prevent duplicate business effects
```

This is a required at-least-once scenario and SHOULD be tested.

---

# Kafka Topic Isolation

Kafka integration tests MUST use isolated topic names.

Prefer:

```text
test-<run-id>-treasury-events
test-<run-id>-domain-events
```

Consumer groups MUST also be isolated per test/suite where needed.

Do not reuse development consumer groups.

---

# Controller Tests

Controller unit tests SHOULD remain thin.

Verify only controller-owned behavior such as:

```text
DTO forwarded correctly
@CurrentUser() forwarded when required
service result returned
```

Do not duplicate domain service behavior in controller tests.

Authentication wiring belongs mainly in integration/E2E tests.

---

# DTO and Validation Tests

Use NestJS validation in integration/E2E tests for important request contracts.

Cover:

```text
missing required field
invalid UUID
invalid currency
invalid amount
unexpected property
malformed pagination/query values where applicable
```

The global `ValidationPipe` behavior SHOULD be tested once at application integration level, not repeated exhaustively for every controller.

---

# Configuration Tests

Configuration uses:

```text
@nestjs/config
envalid
```

Test important validation behavior:

```text
valid configuration loads
required database configuration missing → startup failure
required Kafka configuration missing → startup failure
required JWT configuration missing → startup failure
malformed values → startup failure
```

Do not read real developer `.env` files in tests.

Use explicit test environment values.

---

# Logging Tests

Do not broadly unit test NestJS Logger.

Security-sensitive tests SHOULD verify where practical that responses/logging helpers do not expose:

```text
passwords
password hashes
access tokens
refresh tokens
Authorization headers
database credentials
```

Normal passing tests SHOULD remain quiet.

Remove committed debugging `console.log` calls.

---

# Error Mapping Tests

Prefer domain/application errors over infrastructure strings.

Good:

```text
InsufficientCapacityError
ReservationAlreadyExistsError
ReservationNotFoundError
FxRateUnavailableError
ReconciliationVersionConflictError
```

Avoid asserting:

```text
ECONNREFUSED 172.x.x.x
duplicate key value violates unique constraint ...
```

unless testing the low-level repository/infrastructure boundary that maps those errors.

---

# Test Data

Use small factories such as:

```text
createTestUser()
createTestProgram()
createTestInvoice()
createTestReservation()
createTestRelease()
createTreasuryEvent()
createReconciliationSnapshot()
```

Factories SHOULD:

- use deterministic defaults
- allow overrides
- use obviously fake data
- avoid hidden mutable shared state

Prefer:

```text
user@example.test
```

for test email addresses.

---

# Sensitive Test Data

Tests MUST NOT contain:

- production JWT secrets
- real passwords
- real refresh tokens
- real database credentials
- real Kafka credentials
- real user data

Use clearly fake test-only values.

---

# Determinism

Tests MUST NOT depend on:

- test execution order
- live public network availability
- local machine timezone
- existing developer PostgreSQL data
- existing Kafka topics/groups
- arbitrary sleeps
- random values without controlled assertions

Use UTC timestamps.

---

# Cleanup

Integration tests MUST close:

```text
NestJS applications
PostgreSQL pools
Kafka producers
Kafka consumers
HTTP test servers
timers
```

Created database state/topics SHOULD be cleaned or isolated.

Do not leave open handles after Jest completes.

---

# Parallel Execution

Unit tests SHOULD be parallel-safe.

Integration tests sharing PostgreSQL or Kafka MUST isolate:

```text
database rows/schema
topic names
consumer groups
event IDs
```

If a suite genuinely requires serial execution, configure and document that explicitly.

---

# CI

CI MUST be runnable from a clean environment.

CI MUST NOT depend on:

- developer `.env`
- local PostgreSQL
- local Kafka
- live Frankfurter
- manual topic/database creation

Docker Compose or equivalent test setup SHOULD create required infrastructure automatically.

---

# Required Test Matrix

## Money

```text
UNIT
├── arithmetic
├── comparison
├── currency mismatch
├── precision
├── rounding
└── immutability
```

## Users/Auth

```text
UNIT
├── registration
├── password hashing
├── login validation
├── access token issuance
├── refresh token issuance
├── refresh rotation
└── identity mapping

INTEGRATION
├── UsersRepository + PostgreSQL
├── JwtAccessGuard + Passport
├── JwtRefreshGuard + Passport
└── @CurrentUser()

E2E
├── register
├── login
├── refresh
├── unauthorized domain request
└── authorized domain request
```

## Programs

```text
UNIT
├── total/reserved/available capacity
└── business validation

INTEGRATION
├── PostgreSQL persistence
└── row locking
```

## Invoices

```text
UNIT
├── original money
├── USD conversion
└── FX failure

INTEGRATION
└── persistence
```

## Reservations

```text
UNIT
├── successful reserve
├── insufficient capacity
├── duplicate invoice reservation
└── original + converted money

INTEGRATION
├── PostgreSQL transaction
├── row locking
└── concurrent oversubscription prevention
```

## Releases

```text
UNIT
├── successful release
├── duplicate release
├── missing reservation
└── exact reserved USD amount restored

INTEGRATION
└── atomic persistence/capacity update
```

## Reconciliation

```text
UNIT
├── newer snapshot
├── stale snapshot
├── duplicate snapshot
├── missing-event recovery
└── local reservation preservation

INTEGRATION
├── inbox idempotency
├── transactional update
└── bulk processing behavior
```

## Kafka

```text
INTEGRATION
├── @ConsumeOneMessage
├── @ConsumeBatch
├── manual offset commit
├── redelivery
├── inbox deduplication
├── transactional outbox
└── publisher retry
```

## Frankfurter Client

```text
UNIT
└── mapping/error translation

INTEGRATION
├── request construction
├── response mapping
├── timeout
├── 4xx
├── 5xx
└── malformed response
```

---

# Bug Fixes

A bug fix SHOULD include a regression test when practical.

Preferred flow:

```text
write failing test
    ↓
confirm failure
    ↓
fix implementation
    ↓
confirm success
```

---

# Coverage

Coverage is a diagnostic tool, not the goal.

Prioritize coverage of:

- business invariants
- concurrency
- money precision
- transaction rollback
- Kafka duplicate delivery
- reconciliation ordering
- authentication boundaries
- error paths

Do not write low-value tests only to increase a percentage.

---

# Test Commands

The repository SHOULD expose commands equivalent to:

```text
test
test:watch
test:cov
test:unit
test:integration
test:e2e
```

Optional:

```text
test:external
```

for explicitly opt-in live integration smoke tests.

---

# Developer Test Flow

During development:

```text
1. run targeted unit tests
2. run targeted integration tests
3. run full unit suite
4. run affected integration/E2E suites
5. run lint
6. run typecheck
7. run build
```

All applicable checks MUST pass before completion.

---

# Testing Anti-Patterns

Do not introduce:

- live Frankfurter dependency in normal tests
- mocked PostgreSQL as the only repository verification
- mocked Kafka as the only delivery-semantics verification
- authentication bypasses for test convenience
- tests for unsupported auth mechanisms
- arbitrary `setTimeout` waits
- test-order dependencies
- production credentials
- large snapshots by default
- mocks of private methods
- tests dominated by `toHaveBeenCalled`
- tests that prove implementation details instead of business behavior
- shared mutable fixtures
- `.only` committed to the repository
- disabled tests without a documented reason
- floating-point money assertions
- concurrency behavior tested only with mocks

---

# Rules for AI-Generated Tests

When adding or modifying tests:

1. Identify the business or architectural guarantee being tested.
2. Use unit tests for business decisions and value objects.
3. Use real PostgreSQL for repository, transaction, locking, and concurrency behavior.
4. Use real Kafka for offset, redelivery, batching, and at-least-once behavior.
5. Use inbox/outbox integration tests to prove idempotency and atomicity.
6. Never call live Frankfurter in normal tests.
7. Use a controlled HTTP server for Axios integration tests.
8. Test JWT only; never add another auth mechanism.
9. Cover failure paths, not only happy paths.
10. Keep fixtures fake and deterministic.
11. Do not mock implementation details.
12. Do not weaken production validation/security for tests.
13. Follow `BUSINESS.md` for domain invariants.
14. Follow `ARCHITECTURE.md` for module boundaries.
15. Follow `INFRASTRUCTURE.md` for PostgreSQL/Kafka guarantees.
16. Follow `SECURITY.md` for JWT behavior.
17. Add regression tests for bugs when useful.
18. Clean up infrastructure resources.
19. Use UTC for timestamps.
20. Run all relevant checks before declaring completion.

---

# Definition of Done

A feature is sufficiently tested when the applicable path is covered:

```text
business rule
    ↓
unit test

persistence / transaction / locking
    ↓
PostgreSQL integration test

Kafka delivery guarantee
    ↓
Kafka integration test

security wiring
    ↓
NestJS/Passport integration test

critical user workflow
    ↓
E2E test
```

At minimum verify where applicable:

- success
- invalid input
- missing entity
- duplicate request/event
- infrastructure failure
- transaction rollback
- concurrency
- authentication
- timestamps
- money precision

All applicable commands MUST succeed:

```text
format
lint
typecheck
test:unit
test:integration
test:e2e
build
```

Use the actual repository script names.

---

# Final Testing Rule

```text
Business decision?
    → Unit test

Money behavior?
    → Unit test

PostgreSQL transaction/locking?
    → PostgreSQL integration test

Kafka offset/redelivery/idempotency?
    → Kafka integration test

Axios integration?
    → Controlled HTTP integration test

NestJS/Passport JWT wiring?
    → Integration test

Critical complete workflow?
    → E2E test
```

Do not mock away the behavior you are trying to prove.
