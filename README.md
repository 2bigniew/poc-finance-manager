# poc-finance-manager

Program Capacity & Invoice Reservation service (POC). Tracks financing-program capacity,
invoice reservations/releases, and reconciles treasury capacity received through Kafka.

See `docs/specs/` for the full domain/architecture/infrastructure/security/testing/style
specification. `CLAUDE.md` is the entry point for that spec set.

## Prerequisites

- Docker and Docker Compose
- Node.js 24.x (only needed for running tests/lint outside Docker; the app itself runs
  entirely in containers)

## Running locally

```bash
cp .env.example .env
docker compose up --build
```

This builds the application image, starts PostgreSQL and Kafka (KRaft mode, single
node), waits for both to become healthy, runs pending database migrations, then starts
the application on `http://localhost:3000`.

No manual topic creation or database setup is required — migrations run automatically as
part of the container's startup command, and Kafka topics are created on first use.

Check readiness:

```bash
curl http://localhost:3000/health      # process liveness
curl http://localhost:3000/readiness   # process liveness + PostgreSQL reachability
```

To reset to a completely clean state (drops all data/volumes):

```bash
docker compose down -v
docker compose up --build
```

## Configuration

All configuration is environment-based (`@nestjs/config` + `envalid`); see
`.env.example` for every variable and a safe local default. Invalid or missing required
configuration fails application startup immediately — there is no silent fallback.

Secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SQL_PASSWORD`) in `.env.example` are
placeholder local-only values. Do not reuse them outside local development.

## Running tests

```bash
npm ci

npm run test:unit          # no external infrastructure required

# Integration/E2E tests require real PostgreSQL + Kafka. Either use the Compose stack's
# postgres/kafka services (docker compose up -d postgres kafka) or run them locally on
# the default ports (5432, 9092). A dedicated `finance_manager_test` database is created
# automatically by docker/postgres/init/01-create-test-database.sql.
npm run test:integration
npm run test:e2e

npm run lint
npm run typecheck
npm run format:check
npm run build
```

Integration/E2E tests read connection settings from `test/setup-test-env.ts`, not from
your `.env` — they never touch the developer database or developer Kafka topics.

## Migrations

```bash
npm run migrate:up
npm run migrate:down
```

These use the same Kysely migration files the application container runs on startup
(`src/app/modules/database/migrations/`).

## Example flow

All domain endpoints require a JWT access token. Registration and login are the only
public domain-adjacent endpoints (plus `/health` and `/readiness`).

```bash
BASE=http://localhost:3000

# Register + login
curl -s -X POST $BASE/users/register -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.test","password":"SuperSecret123!"}'
TOKENS=$(curl -s -X POST $BASE/users/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.test","password":"SuperSecret123!"}')
ACCESS=$(echo "$TOKENS" | jq -r .access_token)
REFRESH=$(echo "$TOKENS" | jq -r .refresh_token)

# Create a Program (capacity is always USD)
PROGRAM_ID=$(curl -s -X POST $BASE/programs -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo Program","originalCapacityAmount":"1000","originalCapacityCurrency":"USD","totalCapacityUsdAmount":"1000"}' \
  | jq -r .id)

# Create a non-USD Invoice (converted to USD via Frankfurter and snapshotted)
INVOICE_ID=$(curl -s -X POST $BASE/invoices -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"externalReference":"INV-1","amount":"100","currency":"EUR"}' \
  | jq -r .id)

# Reserve it against the Program (consumes capacity, using the Invoice's own FX snapshot)
curl -s -X POST "$BASE/programs/$PROGRAM_ID/reservations" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d "{\"invoiceId\":\"$INVOICE_ID\"}"

# Inspect derived capacity (reservedCapacityUsd/availableCapacityUsd are always computed
# from active Reservations, never a mutable counter)
curl -s "$BASE/programs/$PROGRAM_ID" -H "Authorization: Bearer $ACCESS"

# Refresh tokens are passed in the request body, not as a bearer token
curl -s -X POST $BASE/auth/refresh -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}"
```

### Testing the Kafka reconciliation flow

Treasury capacity snapshots arrive as bulk messages on the `treasury.reconciliation`
topic (one message, `{ batchId, programs: [...] }`, independently processed per
`programId`). To exercise it without a real treasury system, publish a message directly,
e.g. with `kcat`/`kafkacat` or any Kafka client:

```json
{
  "batchId": "manual-batch-1",
  "programs": [
    {
      "programId": "<a Program UUID>",
      "sourceVersion": 1,
      "totalCapacityUsd": "2000.0000",
      "effectiveAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

`sourceVersion` must be greater than the Program's current `treasuryVersion`
(`GET /programs/:id`) to be applied; equal-or-lower versions are recorded as
`IGNORED_STALE` and have no effect. Applying a snapshot only ever replaces
`totalCapacityUsd`/`treasuryVersion` — it never touches Reservations, Releases, or
Invoices.

## Outbound events

Reservation/Release/Reconciliation commits write to a transactional outbox in the same
PostgreSQL transaction as the business state change; a background publisher
(`OutboxPublisherService`) delivers them to Kafka at-least-once:

| Event | Topic | Key |
|---|---|---|
| `reservation.created` | `reservations.events` | `programId` |
| `release.created` | `releases.events` | `programId` |
| `reconciliation.applied` | `reconciliations.events` | `programId` |

Delivery is at-least-once by design — duplicate publication of the same `eventId` is
possible and expected; consumers of these topics are responsible for their own
idempotency.

## Known limitations / open decisions

- **Reconciliation vs. currently-reserved capacity.** `CLAUDE.md`/`BUSINESS.md` state
  unconditionally that available capacity must never be negative, but the documented
  Bulk Reconciliation semantics are a pure replacement of `totalCapacityUsd` with no
  validation against currently-reserved capacity, and reconciliation is explicitly
  forbidden from mutating local Reservations to compensate. If a treasury snapshot sets
  `totalCapacityUsd` below the sum of currently ACTIVE Reservations, the Program row
  updates exactly as received (this is correct per the reconciliation contract), but
  `GET /programs/:id` then fails with a 500 rather than returning a negative number,
  because the capacity-derivation math intentionally throws instead of silently
  producing an invalid negative value. This is flagged rather than silently resolved: a
  product decision is needed (e.g. floor displayed availability at zero, reject/flag such
  snapshots, or something else) before this can occur in production.
- **Single Outbox Publisher instance.** `OutboxPublisherService` has no cross-instance
  claim/lease; it assumes one running application instance. Multiple instances would
  race harmlessly (Kafka delivery is already at-least-once and idempotent downstream)
  but not efficiently. A real multi-worker deployment would need an explicit
  claim/lease schema addition.
