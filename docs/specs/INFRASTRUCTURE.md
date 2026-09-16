# Infrastructure

## Purpose

This document defines the local runtime, persistence, messaging, and external HTTP integration rules for the Program Capacity & Invoice Reservation service.

The project is a POC and MUST be runnable locally with Docker Compose.

---

# Runtime Topology

```text
Client
  |
  | HTTP
  v
Application
  |        \
  |         \ Axios
  |          v
  |       Frankfurter API
  |
  +---- PostgreSQL
  |
  +---- Kafka (KRaft)
            ^
            |
         Treasury
```

Docker Compose MUST start the infrastructure required by the application:

```text
application
postgres
kafka
```

Persistent Docker volumes SHOULD be used for PostgreSQL and Kafka data.

For this POC, one Kafka node is sufficient.

---

# PostgreSQL

PostgreSQL is the only application database and the main transactional boundary.

It stores:

- domain entities defined in `BUSINESS.md`;
- consumed Kafka event identities;
- transactional outbox events;
- reconciliation history.

Persistence rules:

- UUIDs MUST use PostgreSQL UUID-compatible storage;
- timestamps MUST use timezone-aware UTC timestamps;
- monetary amounts and FX rates MUST use exact decimal / `NUMERIC`, never floating point;
- schema changes MUST be managed through migrations;
- required uniqueness and idempotency rules MUST be enforced with database constraints where possible.

Capacity-affecting operations SHOULD serialize per Program using a PostgreSQL row lock inside the transaction, for example `SELECT ... FOR UPDATE` or the ORM equivalent.

This applies to both HTTP reservation/release operations and Kafka capacity/reconciliation processing.

---

# Kafka

Kafka MUST run in KRaft mode without ZooKeeper.

For local development use one combined broker/controller node:

```text
process.roles = broker,controller
```

Combined KRaft mode is acceptable because this is a local POC, not a production Kafka deployment.

Use the official Apache Kafka image and pin the image version. At the time this document was created, the current supported release is:

```text
apache/kafka:4.3.1
```

Single-node Kafka requires replication-related internal topics to use replication factor `1`.

Topics SHOULD be created explicitly rather than relying on automatic topic creation.

Treasury messages SHOULD use `programId` as the Kafka message key whenever one message represents one Program so ordering is preserved within that Program partition.

---

# Delivery Semantics

The application uses **at-least-once** Kafka processing.

At-least-once means the same Kafka message MAY be delivered more than once. The application MUST therefore be idempotent.

Consumer configuration MUST disable automatic offset commits:

```text
enable.auto.commit = false
```

A Kafka offset MUST be committed only after the corresponding PostgreSQL transaction succeeds.

Conceptual flow:

```text
poll Kafka message
    ↓
begin PostgreSQL transaction
    ↓
register inbound event / deduplicate
    ↓
apply domain changes
    ↓
write required outbox events
    ↓
commit PostgreSQL transaction
    ↓
commit Kafka offset
```

If processing fails before the PostgreSQL commit:

```text
rollback DB transaction
DO NOT commit Kafka offset
message is retried
```

If the DB commit succeeds but offset commit fails, Kafka may redeliver the message. Idempotent consumption MUST make this safe.

---

# Idempotent Consumption / Inbox

Consumed Kafka messages MUST have a stable external `eventId`.

The application MUST persist consumed event identities in a dedicated table, conceptually:

```text
inbox_events
------------
id
consumer_group
event_id
topic
partition
offset
received_at
processed_at
```

A unique constraint MUST prevent the same logical event from being applied twice, for example:

```text
UNIQUE (consumer_group, event_id)
```

The inbox record and domain mutation MUST be committed in the same PostgreSQL transaction.

Duplicate delivery MUST result in no repeated domain side effects.

Business-level version checks from `BUSINESS.md` still apply independently of event ID deduplication.

---

# Transactional Outbox

Any Kafka event produced as a consequence of a domain change MUST use the transactional outbox pattern.

The domain change and outbox insert MUST happen in the same PostgreSQL transaction.

Conceptual table:

```text
outbox_events
-------------
id / event_id
topic
message_key
event_type
payload JSONB
created_at
published_at
attempts
```

An outbox publisher reads unpublished rows and publishes them to Kafka.

After Kafka acknowledges the publish, the row is marked as published.

Producer settings SHOULD include:

```text
acks = all
enable.idempotence = true
retries > 0
```

Producer idempotence reduces duplicate writes caused by producer retries, but it does NOT replace application-level event IDs and idempotent consumers.

A crash after Kafka publish but before `published_at` is stored can cause the outbox event to be published again. Downstream consumers MUST therefore also treat Kafka delivery as at-least-once.

---

# Kafka Failure Handling

Transient processing failures SHOULD leave the offset uncommitted so Kafka can retry the message.

Poison messages MUST NOT block a partition forever.

The implementation SHOULD define a bounded retry policy and a dead-letter topic for messages that cannot be processed after repeated attempts.

Failures MUST include enough structured context to diagnose:

```text
eventId
eventType
programId when available
topic
partition
offset
```

---

# External HTTP / Axios

All outbound HTTP calls MUST use Axios through a dedicated integration/gateway layer.

For the current domain this primarily applies to:

```text
Frankfurter API
https://api.frankfurter.dev
```

Controllers and domain entities MUST NOT call Axios directly.

Conceptual flow:

```text
Application service
    ↓
CurrencyExchangeGateway
    ↓
Axios instance
    ↓
Frankfurter API
```

The shared Axios instance MUST provide:

- configurable base URL;
- finite request timeout;
- response validation;
- consistent error mapping;
- request correlation/logging where applicable.

External API failures MUST be translated into application-level integration errors rather than leaking raw Axios errors through HTTP endpoints.

Currency conversion rules remain defined by `BUSINESS.md`.

---

# Docker Compose

`docker compose up --build` SHOULD be sufficient to start the local system.

The Compose setup SHOULD provide:

- application container;
- PostgreSQL container with persistent volume;
- single-node Kafka KRaft container with persistent volume;
- service health checks;
- application startup only after required dependencies are healthy;
- environment-based configuration.

The application SHOULD NOT depend on host-installed PostgreSQL or Kafka.

A migration step MUST run before normal application traffic is accepted.

---

# Configuration

Environment variables SHOULD be used for runtime configuration.

At minimum configure:

```text
DATABASE_URL
KAFKA_BROKERS
KAFKA_CONSUMER_GROUP
FRANKFURTER_BASE_URL
HTTP_TIMEOUT_MS
```

Authentication configuration and secrets MUST also come from environment/configuration and MUST NOT be committed to source control.

Provide an `.env.example` containing safe local example values only.

---

# Health and Readiness

The application SHOULD expose health/readiness endpoints suitable for Docker Compose health checks.

Readiness SHOULD verify dependencies required to serve requests, especially PostgreSQL.

Kafka connectivity SHOULD be observable, but temporary Kafka unavailability MUST NOT corrupt HTTP-side transactional state.

---

# Logging

Use structured application logs.

Important operations SHOULD include correlation identifiers where available:

```text
requestId
eventId
programId
invoiceId
reservationId
```

Do not log secrets or authentication credentials.

---

# POC Trade-offs

The following choices are intentional for this task:

- one PostgreSQL instance;
- one Kafka broker/controller in combined KRaft mode;
- Kafka replication factor `1` locally;
- Docker Compose instead of an orchestrator;
- PostgreSQL row locking instead of distributed locking;
- at-least-once messaging with explicit application idempotency rather than Kafka exactly-once transactions;
- database-backed transactional inbox/outbox rather than additional infrastructure.

A single Kafka node provides no broker high availability. This is acceptable for local POC execution and MUST NOT be presented as a production Kafka topology.

---

# Core Infrastructure Invariants

1. PostgreSQL is the transactional source of persisted application state.
2. Kafka delivery is at-least-once; duplicate messages are expected.
3. Kafka offsets are committed only after successful DB commit.
4. Inbound event identity and domain changes are committed atomically.
5. Domain changes and outbound events are committed atomically through the outbox.
6. All Kafka consumers MUST be idempotent.
7. Money and FX values MUST use exact decimal database types.
8. Capacity-affecting operations MUST be safe under concurrent HTTP and Kafka processing.
9. External HTTP traffic MUST use Axios through a dedicated integration boundary.
10. The complete application MUST run locally through Docker Compose.

---

# Rules for AI-Generated Infrastructure Changes

When modifying infrastructure or integration code:

1. Preserve at-least-once Kafka semantics.
2. Never enable consumer auto-commit for business consumers.
3. Never apply a Kafka domain mutation outside the transaction that records its inbox event.
4. Never publish transactional side effects directly before the DB commit; use the outbox.
5. Preserve database uniqueness constraints used for idempotency.
6. Preserve per-Program concurrency safety for capacity changes.
7. Use exact decimal database types for money and FX rates.
8. Keep Axios behind integration/gateway abstractions.
9. Keep local infrastructure reproducible with Docker Compose.
10. Update this document when intentionally changing an infrastructure invariant or delivery guarantee.

---

# References

- Apache Kafka KRaft documentation: https://kafka.apache.org/documentation/#kraft
- Apache Kafka configuration: https://kafka.apache.org/documentation/#configuration
- Apache Kafka downloads: https://kafka.apache.org/community/downloads/
- Axios documentation: https://axios-http.com/docs/intro
