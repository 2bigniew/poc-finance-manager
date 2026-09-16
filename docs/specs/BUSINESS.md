# Business Rules

## Purpose

This document defines the business model and invariants for the Program Capacity & Invoice Reservation service.

The service tracks financing-program capacity, invoice reservations and releases, and reconciles treasury capacity received through Kafka.

All HTTP endpoints MUST be authenticated.

---

# Domain Overview

```text
User
  │ authenticated action
  ▼
Invoice ──> Reservation ──> Release
                 │
                 ▼
              Program
                 ▲
                 │ capacity updates / reconciliation
              Treasury
                 │
               Kafka
```

USD is the canonical accounting and capacity currency.

Original currencies and amounts MUST be preserved. Converted USD values MUST be stored separately and used for capacity calculations.

---

# Global Entity Rules

Every persisted domain entity MUST contain:

```ts
id: UUID;
createdAt: UTC timestamp;
updatedAt: UTC timestamp;
```

Timestamps MUST be application-managed and represented in ISO-8601 UTC.

Entity IDs are immutable and MUST NOT be reused.

---

# Money Value Object

`Money` follows the Martin Fowler Money pattern: amount and currency form one immutable value.

```ts
interface Money {
  amount: Decimal;
  currency: CurrencyCode; // ISO-4217, e.g. USD, EUR, PLN
}
```

Rules:

- `Money` MUST be immutable.
- Floating-point types MUST NOT be used for monetary calculations.
- Equality requires both equal amount and equal currency.
- Addition, subtraction and comparison are allowed only for the same currency.
- Multiplication uses decimal arithmetic and deterministic currency rounding.
- Amounts MUST respect the currency's minor-unit precision.
- Allocation, if implemented, MUST preserve the original total exactly.
- Currency exchange is a separate domain operation; `Money` itself does not fetch exchange rates.

---

# Currency Exchange

Exchange rates MUST come from Frankfurter:

```text
https://api.frankfurter.dev/v2/rate/{from}/{to}
```

USD is the target currency for all capacity-related conversions.

If the source currency is already USD:

```text
rate = 1
no external request is required
```

Every performed conversion MUST preserve the conversion snapshot:

```ts
interface MoneyConversion {
  original: Money;
  converted: Money;      // USD
  rate: Decimal;
  rateDate: string;      // rate date returned by Frankfurter
  source: "frankfurter.dev";
}
```

A stored conversion MUST NOT change when newer FX rates become available.

---

# User Entity

A User represents an authenticated application identity.

```ts
interface User {
  id: UUID;
  email: string;
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

Users authenticate actions but do not own Programs, Invoices or Reservations unless ownership is explicitly introduced later.

---

# Program Entity

A Program represents a financing program with a credit limit.

```ts
interface Program {
  id: UUID;
  name: string;
  originalCapacity: Money;
  totalCapacityUsd: Money; // always USD
  treasuryVersion: number;
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

`totalCapacityUsd` is the authoritative capacity used by this service.

Available capacity is derived:

```text
reservedCapacityUsd = SUM(active Reservation.convertedMoney)
availableCapacityUsd = totalCapacityUsd - reservedCapacityUsd
```

Available capacity MUST never become negative.

---

# Invoice Entity

An Invoice represents a receivable eligible for early payment.

```ts
interface Invoice {
  id: UUID;
  externalReference: string;
  originalMoney: Money;
  convertedMoney: Money; // USD
  conversion: MoneyConversion;
  status: "OPEN" | "RESERVED" | "REPAID";
  createdByUserId: UUID;
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

The original amount and currency MUST always be preserved.

`convertedMoney` is stored for clarity and audit. Reservation capacity is determined by the Reservation's own stored conversion.

---

# Reservation Entity

A Reservation allocates part of a Program's capacity to an Invoice.

```ts
interface Reservation {
  id: UUID;
  programId: UUID;
  invoiceId: UUID;
  originalMoney: Money;
  convertedMoney: Money; // USD
  conversion: MoneyConversion;
  status: "ACTIVE" | "RELEASED";
  createdByUserId: UUID;
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

Rules:

- Creating a Reservation MUST atomically verify sufficient available capacity.
- An active Reservation consumes `convertedMoney` from Program capacity.
- The original invoice currency and amount MUST be preserved.
- A Reservation MUST keep the FX rate used at reservation time.
- The same Invoice MUST NOT have more than one active Reservation.
- Capacity MUST NOT be oversubscribed under concurrent requests.

---

# Release Entity

A Release returns previously reserved capacity after repayment.

```ts
interface Release {
  id: UUID;
  reservationId: UUID;
  invoiceId: UUID;
  programId: UUID;
  originalMoney: Money;
  convertedMoney: Money; // USD
  conversion: MoneyConversion;
  createdByUserId: UUID;
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

Rules:

- A Release MUST use the exact monetary values and FX conversion stored on the Reservation.
- A Release MUST NOT fetch or apply a new exchange rate.
- Releasing a Reservation restores exactly its `convertedMoney` to available capacity.
- A Reservation MUST NOT be released twice.
- This scope supports full release only; partial release is not supported.

---

# Reconciliation Entity

A Reconciliation records one authoritative treasury capacity snapshot for one Program.

```ts
interface Reconciliation {
  id: UUID;
  batchId: string;
  externalEventId: string;
  programId: UUID;
  sourceVersion: number;
  totalCapacityUsd: Money; // reconciliation currency is USD
  effectiveAt: timestamp;
  status: "APPLIED" | "IGNORED_STALE" | "FAILED";
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

Treasury is the source of truth for Program total capacity.

Reservations and Releases are owned by this service and MUST NOT be deleted or recreated by reconciliation.

Applying reconciliation updates the Program's `totalCapacityUsd`; reserved and available capacity are then recalculated from local active Reservations.

---

# Bulk Reconciliation

A bulk reconciliation is a Kafka message containing authoritative capacity snapshots for multiple Programs.

```text
BulkReconciliationMessage
  ├── batchId
  └── programs[]
        ├── programId
        ├── sourceVersion
        ├── totalCapacityUsd
        └── effectiveAt
```

Each Program entry MUST be processed independently and atomically.

For each Program:

```text
incoming sourceVersion <= Program.treasuryVersion
    -> ignore as stale or duplicate

incoming sourceVersion > Program.treasuryVersion
    -> replace treasury-owned totalCapacityUsd
    -> set treasuryVersion
    -> recalculate availability from active Reservations
```

A reconciliation snapshot subsumes missing treasury capacity events up to its `sourceVersion`. Those older missing events do not need to be replayed after the snapshot is applied.

Events newer than the reconciliation version MUST still be applied normally.

Kafka messages SHOULD use `programId` as the partition key when messages are per Program.

---

# Capacity Updates

Normal treasury Kafka events represent incremental or newer capacity information.

They MUST carry an external event ID and a monotonic Program `sourceVersion`.

Rules:

- duplicate events MUST be idempotent;
- stale versions MUST NOT overwrite newer state;
- a detected version gap SHOULD mark the Program as requiring reconciliation or produce an operational alert;
- a later valid reconciliation snapshot restores a trusted capacity checkpoint.

---

# Main Business Workflows

## Reserve Invoice

```text
authenticated request
    -> load Invoice and Program
    -> convert Invoice amount to USD using Frankfurter
    -> atomically verify available capacity
    -> create Reservation
    -> mark Invoice RESERVED
```

## Release Reservation

```text
authenticated request
    -> load active Reservation
    -> create Release using Reservation money values
    -> mark Reservation RELEASED
    -> mark Invoice REPAID
    -> capacity becomes available again
```

## Reconcile Capacity

```text
Kafka bulk snapshot
    -> validate message
    -> process each Program independently
    -> reject stale/duplicate versions
    -> update authoritative USD total capacity
    -> derive availability from active Reservations
```

---

# Core Invariants

1. USD is the canonical currency for capacity calculations and reconciliation.
2. Original monetary amount and currency are never discarded.
3. Monetary calculations never use floating point.
4. Reservation creation cannot make available capacity negative.
5. Release restores exactly the USD amount originally reserved.
6. FX rates are historical facts once stored and MUST NOT be silently refreshed.
7. Treasury owns Program total capacity; this service owns Invoice, Reservation and Release lifecycle.
8. Reconciliation changes treasury-owned capacity, not local Reservation history.
9. Kafka processing and reservation/release commands MUST be idempotent where retries are possible.
10. All HTTP endpoints require authentication.

---

# Assumptions and Scope

- USD is the default and canonical internal currency.
- Reconciliation messages are denominated in USD.
- Frankfurter v2 provides FX rates.
- FX conversion is fixed when the relevant business operation is created.
- Full releases only; partial releases are out of scope.
- One Invoice may have at most one active Reservation.
- `sourceVersion` is monotonic per Program.
- Bulk reconciliation is authoritative for treasury-owned Program capacity only.

---

# Rules for AI-Generated Changes

When modifying this domain:

1. Preserve the Money rules and original/converted monetary values.
2. Never use floating-point arithmetic for money or FX rates.
3. Never revalue an existing Reservation or Release with a newer FX rate.
4. Keep treasury-owned capacity separate from service-owned Reservation state.
5. Preserve idempotency and version checks for Kafka processing.
6. Preserve atomic capacity checks for concurrent Reservations.
7. Add or update tests when changing a business invariant.
8. Update this document when intentionally changing the domain model or assumptions.
