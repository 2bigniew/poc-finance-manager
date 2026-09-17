I’d use this sequence:

Database migrations + constraints
Programs module
Currency exchange + Invoices module
Reservations module
Releases module
Reconciliation + Kafka domain consumers
Outbox publisher / event delivery completion
Full local/E2E validation + hardening
1. Database migrations + constraints

You already have the Kysely table contracts, so this is the natural point to turn them into the actual PostgreSQL schema.

Create migrations for all currently known tables:

users
refresh_tokens

programs
invoices
reservations
releases
reconciliations

reservation_events
release_events
reconciliation_events

outbox_events

This step should also establish the important DB-level guarantees rather than relying solely on services:

PK/FK constraints
unique normalized user email
exact NUMERIC money/FX columns
timestamps
event idempotency uniqueness
outbox indexes
reconciliation/version indexes
one active Reservation per Invoice

Especially important:

UNIQUE active reservation per invoice

should ideally be enforced through a partial unique index.

After this step, every subsequent module can have real PostgreSQL repository integration tests.

2. Programs module

Then implement Programs first.

It is the aggregate around which capacity revolves:

Program
├── totalCapacityUsd
├── treasuryVersion
├── reservedCapacityUsd   derived
└── availableCapacityUsd  derived

Implement:

ProgramsRepository
ProgramsService
ProgramsController
DTOs
errors
repository integration tests
service unit tests
HTTP/E2E tests

This is also where I would establish the reusable repository method for:

findByIdForUpdate()

because Reservations, Releases, and reconciliation will all depend on the same Program locking behavior.

3. Currency exchange + Invoices

I would combine these rather than putting FX into the Reservation step.

First implement the reusable Frankfurter integration:

FrankfurterClient
CurrencyExchangeService / MoneyConversion service
Money conversion types
error mapping
Axios integration tests

Then implement Invoices:

Invoice
InvoiceRepository
InvoiceService
InvoiceController
DTOs

Invoice creation can establish:

originalMoney
convertedMoneyUsd
conversionRate
conversionRateDate
conversionSource

That gives Reservation a stable Invoice to work from.

Even if Reservation ultimately performs its own conversion snapshot, having the Invoice module first makes the dependency clear:

Invoice exists
↓
Reservation is created against Invoice
4. Reservations

This should be one of the most heavily tested steps.

Implement the complete use case:

authenticated request
↓
load Invoice
↓
load + lock Program
↓
obtain/fix required USD amount
↓
calculate currently reserved capacity
↓
verify available capacity
↓
create Reservation
↓
mark Invoice RESERVED
↓
write ReservationEvent/outbox if required
↓
commit

The crucial test here is real PostgreSQL concurrency:

Program capacity: $100

A reserves $80
B reserves $80

Only one may succeed.

This is where you prove that FOR UPDATE and the transaction design actually prevent oversubscription.

5. Releases

Releases naturally follow Reservations.

Flow:

load Reservation
↓
verify ACTIVE
↓
lock Program
↓
create Release
↓
mark Reservation RELEASED
↓
mark Invoice REPAID
↓
write ReleaseEvent/outbox
↓
commit

The key invariant:

Release USD amount
==
original Reservation USD amount

No Frankfurter call.

No revaluation.

Also test duplicate release behavior carefully.

6. Reconciliation + Kafka domain consumers

At this point the local capacity model is complete, so treasury reconciliation becomes much easier to implement correctly.

Implement:

reconciliations.consumer.service.ts

using the Kafka infrastructure you just created.

Flow:

Kafka
↓
@ConsumeBatch / @ConsumeOneMessage
↓
ReconciliationsConsumerService
↓
ReconciliationsService
↓
transaction
├── inbox/event dedup
├── lock Program
├── sourceVersion check
├── update treasury capacity
├── reconciliation record
└── outbox if required

Test:

new version
duplicate version
stale version
version gap
newer authoritative snapshot
local Reservations remain untouched

And for bulk reconciliation, preserve your rule:

each Program processed independently and atomically
7. Outbox publisher / event completion

I would give this its own explicit step rather than hiding it inside reconciliation.

You already have:

OutboxEventsTable
Kafka producer

Now connect them:

unpublished outbox row
↓
BrokerKafkaService.produce(...)
↓
Kafka ACK
↓
publishedAt

Cover the important crash/failure cases:

Kafka failure
→ row remains unpublished

publish succeeds
DB mark-published fails
→ message may be published twice
→ downstream idempotency handles it

You can also finish the concrete:

ReservationEvent
ReleaseEvent
ReconciliationEvent

contracts here.

8. Full local validation and hardening

Then finish with a system-level pass rather than calling it merely "local testing."

Run a realistic flow:

register
↓
login
↓
create Program
↓
create Invoice
↓
reserve Invoice
↓
check reduced capacity
↓
release
↓
check restored capacity
↓
publish treasury reconciliation
↓
consumer processes it
↓
check updated Program state
↓
restart consumer
↓
verify no duplicated effects

Also deliberately test failures:

concurrent reservations
duplicate Kafka events
stale reconciliation
Frankfurter unavailable
PostgreSQL rollback
Kafka unavailable
offset commit failure/redelivery
refresh-token reuse

Then run the complete Docker Compose stack from a clean state.

So my preferred roadmap is:

1. DB migrations + constraints
2. Programs
3. Currency Exchange + Invoices
4. Reservations
5. Releases
6. Reconciliation + Kafka consumers
7. Outbox publisher + event contracts
8. Full E2E/local validation + hardening

The biggest change from your proposal is moving migrations to the front and moving Invoices before Reservations. Those two changes should make every later step substantially easier to implement and test cleanly.