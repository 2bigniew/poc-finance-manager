import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { BrokerKafkaService } from '@app/modules/broker-kafka/broker-kafka.service';
import {
  bootstrapKafkaTestApp,
  collectMessages,
  uniqueTopic,
} from '@app/modules/broker-kafka/test-support/kafka-integration-test.util';
import { buildReservationCreatedEvent } from '@app/modules/domain/reservations/events/reservation-created.event';
import { Reservation } from '@app/modules/domain/reservations/reservation.entity';
import { buildReleaseCreatedEvent } from '@app/modules/domain/releases/events/release-created.event';
import { Release } from '@app/modules/domain/releases/release.entity';
import { buildReconciliationAppliedEvent } from '@app/modules/domain/reconciliations/events/reconciliation-applied.event';
import { Reconciliation } from '@app/modules/domain/reconciliations/reconciliation.entity';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRepository } from './outbox.repository';

function fakeConfigService(
  batchSize: number,
  pollIntervalMs: number,
): ConfigService {
  return {
    getOrThrow: () => ({ batchSize, pollIntervalMs }),
  } as unknown as ConfigService;
}

function buildReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: randomUUID(),
    programId: 'program-1',
    invoiceId: randomUUID(),
    originalMoney: { amount: '80.0000', currency: 'USD' },
    convertedMoneyUsd: { amount: '80.0000', currency: 'USD' },
    conversion: {
      original: { amount: '80.0000', currency: 'USD' },
      converted: { amount: '80.0000', currency: 'USD' },
      rate: '1',
      rateDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    status: 'ACTIVE',
    createdByUserId: randomUUID(),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildRelease(overrides: Partial<Release> = {}): Release {
  return {
    id: randomUUID(),
    reservationId: randomUUID(),
    invoiceId: randomUUID(),
    programId: 'program-1',
    originalMoney: { amount: '80.0000', currency: 'USD' },
    convertedMoneyUsd: { amount: '80.0000', currency: 'USD' },
    conversion: {
      original: { amount: '80.0000', currency: 'USD' },
      converted: { amount: '80.0000', currency: 'USD' },
      rate: '1',
      rateDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    createdByUserId: randomUUID(),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildReconciliation(
  overrides: Partial<Reconciliation> = {},
): Reconciliation {
  return {
    id: randomUUID(),
    batchId: 'batch-1',
    externalEventId: `batch-1:program-1:1`,
    programId: 'program-1',
    sourceVersion: 1,
    totalCapacityUsd: { amount: '1000.0000', currency: 'USD' },
    effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'APPLIED',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('OutboxPublisherService (Postgres + Kafka integration)', () => {
  let db: Kysely<Database>;
  let outboxRepository: OutboxRepository;
  let app: INestApplication;
  let brokerKafkaService: BrokerKafkaService;

  beforeAll(async () => {
    db = createKysely();
    outboxRepository = new OutboxRepository(db);
    app = await bootstrapKafkaTestApp();
    brokerKafkaService = app.get(BrokerKafkaService);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('outboxEvents').execute();
  });

  function buildPublisher(
    batchSize = 50,
    pollIntervalMs = 1000,
  ): OutboxPublisherService {
    return new OutboxPublisherService(
      outboxRepository,
      brokerKafkaService,
      fakeConfigService(batchSize, pollIntervalMs),
    );
  }

  it('publishes an unpublished row to Kafka and marks it published only after acknowledgement', async () => {
    const topic = uniqueTopic('outbox-success');
    const reservation = buildReservation();
    const event = buildReservationCreatedEvent(
      reservation,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const created = await outboxRepository.create({
      id: event.eventId,
      eventId: event.eventId,
      topic,
      messageKey: reservation.programId,
      eventType: event.eventType,
      payload: event,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(created.publishedAt).toBeNull();

    const publisher = buildPublisher();
    await publisher.pollOnce();

    const [record] = await collectMessages(topic, { count: 1 });
    expect(record?.key).toBe(reservation.programId);
    const receivedPayload = JSON.parse(record?.value ?? 'null') as {
      eventId: string;
      eventType: string;
      payload: { reservationId: string };
    };
    expect(receivedPayload.eventId).toBe(event.eventId);
    expect(receivedPayload.eventType).toBe('reservation.created');
    expect(receivedPayload.payload.reservationId).toBe(reservation.id);

    const republished = await outboxRepository.findByEventId(event.eventId);
    expect(republished?.publishedAt).not.toBeNull();
  });

  // CLAUDE.md "Kafka Failure": a transient Kafka outage must not lose the event. The
  // outage is simulated by rejecting exactly one call to the REAL, connected
  // BrokerKafkaService.produce() (the same "spy on one real call" technique already
  // used throughout this codebase to inject a single transient failure), rather than
  // stopping the actual Kafka broker.
  it('leaves the row unpublished when Kafka publication fails, and publishes it on a later poll once Kafka recovers', async () => {
    const topic = uniqueTopic('outbox-kafka-failure');
    const reservation = buildReservation();
    const event = buildReservationCreatedEvent(
      reservation,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await outboxRepository.create({
      id: event.eventId,
      eventId: event.eventId,
      topic,
      messageKey: reservation.programId,
      eventType: event.eventType,
      payload: event,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const produceSpy = jest
      .spyOn(brokerKafkaService, 'produce')
      .mockRejectedValueOnce(new Error('simulated transient Kafka outage'));

    const publisher = buildPublisher();
    await publisher.pollOnce();

    const afterFailure = await outboxRepository.findByEventId(event.eventId);
    expect(afterFailure?.publishedAt).toBeNull();
    expect(afterFailure?.attempts).toBe(1);

    produceSpy.mockRestore();
    await publisher.pollOnce();

    const afterRecovery = await outboxRepository.findByEventId(event.eventId);
    expect(afterRecovery?.publishedAt).not.toBeNull();
    expect(afterRecovery?.attempts).toBe(2);

    const [record] = await collectMessages(topic, { count: 1 });
    expect(record?.key).toBe(reservation.programId);
  });

  // Mandatory (CLAUDE.md "Publish Success + DB Update Failure" / "13/47"): Kafka ACKs
  // the message, but the DB update that would mark the row published fails. The row
  // MUST remain unpublished, and the next poll republishes the SAME eventId - an
  // intentional, accepted at-least-once duplicate. Downstream idempotency (not this
  // service) is the correctness mechanism for that duplicate; this test only proves the
  // duplicate carries stable event identity, per CLAUDE.md's guidance for when no
  // in-project consumer exists to prove idempotency end-to-end.
  it('demonstrates the at-least-once duplicate window: Kafka gets the event twice with the same eventId when marking published fails once', async () => {
    const topic = uniqueTopic('outbox-mark-published-failure');
    const reservation = buildReservation();
    const event = buildReservationCreatedEvent(
      reservation,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await outboxRepository.create({
      id: event.eventId,
      eventId: event.eventId,
      topic,
      messageKey: reservation.programId,
      eventType: event.eventType,
      payload: event,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const markPublishedSpy = jest
      .spyOn(outboxRepository, 'markPublished')
      .mockRejectedValueOnce(new Error('simulated DB failure after Kafka ACK'));

    const publisher = buildPublisher();
    await publisher.pollOnce();

    const afterFirstAttempt = await outboxRepository.findByEventId(
      event.eventId,
    );
    expect(afterFirstAttempt?.publishedAt).toBeNull();

    markPublishedSpy.mockRestore();
    await publisher.pollOnce();

    const afterSecondAttempt = await outboxRepository.findByEventId(
      event.eventId,
    );
    expect(afterSecondAttempt?.publishedAt).not.toBeNull();

    const deliveries = await collectMessages(topic, { count: 2 });
    expect(deliveries).toHaveLength(2);
    const deliveredEventIds = deliveries.map(
      (delivery) =>
        (JSON.parse(delivery.value ?? 'null') as { eventId: string }).eventId,
    );
    // Same logical event delivered twice - not two different events.
    expect(deliveredEventIds[0]).toBe(event.eventId);
    expect(deliveredEventIds[1]).toBe(event.eventId);
  });

  // CLAUDE.md "Restart Recovery": a fresh publisher instance (no in-memory state,
  // simulating an application restart) must still discover and publish a row that was
  // already durably persisted before the restart.
  it('discovers and publishes an unpublished row after a simulated application restart', async () => {
    const topic = uniqueTopic('outbox-restart');
    const reservation = buildReservation();
    const event = buildReservationCreatedEvent(
      reservation,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await outboxRepository.create({
      id: event.eventId,
      eventId: event.eventId,
      topic,
      messageKey: reservation.programId,
      eventType: event.eventType,
      payload: event,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A brand-new instance: no shared in-memory queue/state with anything above.
    const restartedPublisher = buildPublisher();
    await restartedPublisher.pollOnce();

    const republished = await outboxRepository.findByEventId(event.eventId);
    expect(republished?.publishedAt).not.toBeNull();
    await collectMessages(topic, { count: 1 });
  });

  it('publishes Reservation/Release/Reconciliation outbox rows independently, each with its own stored topic/key/payload', async () => {
    const reservationTopic = uniqueTopic('outbox-multi-reservation');
    const releaseTopic = uniqueTopic('outbox-multi-release');
    const reconciliationTopic = uniqueTopic('outbox-multi-reconciliation');

    const reservation = buildReservation({ programId: 'program-multi' });
    const reservationEvent = buildReservationCreatedEvent(
      reservation,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const release = buildRelease({ programId: 'program-multi' });
    const releaseEvent = buildReleaseCreatedEvent(
      release,
      new Date('2026-01-01T00:00:01.000Z'),
    );
    const reconciliation = buildReconciliation({ programId: 'program-multi' });
    const reconciliationEvent = buildReconciliationAppliedEvent(
      reconciliation,
      new Date('2026-01-01T00:00:02.000Z'),
    );

    await outboxRepository.create({
      id: reservationEvent.eventId,
      eventId: reservationEvent.eventId,
      topic: reservationTopic,
      messageKey: reservation.programId,
      eventType: reservationEvent.eventType,
      payload: reservationEvent,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await outboxRepository.create({
      id: releaseEvent.eventId,
      eventId: releaseEvent.eventId,
      topic: releaseTopic,
      messageKey: release.programId,
      eventType: releaseEvent.eventType,
      payload: releaseEvent,
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    await outboxRepository.create({
      id: reconciliationEvent.eventId,
      eventId: reconciliationEvent.eventId,
      topic: reconciliationTopic,
      messageKey: reconciliation.programId,
      eventType: reconciliationEvent.eventType,
      payload: reconciliationEvent,
      createdAt: new Date('2026-01-01T00:00:02.000Z'),
      updatedAt: new Date('2026-01-01T00:00:02.000Z'),
    });

    const publisher = buildPublisher();
    await publisher.pollOnce();

    const [reservationRecord] = await collectMessages(reservationTopic, {
      count: 1,
    });
    const [releaseRecord] = await collectMessages(releaseTopic, { count: 1 });
    const [reconciliationRecord] = await collectMessages(reconciliationTopic, {
      count: 1,
    });

    expect(reservationRecord?.key).toBe('program-multi');
    expect(releaseRecord?.key).toBe('program-multi');
    expect(reconciliationRecord?.key).toBe('program-multi');

    const reservationPublished = await outboxRepository.findByEventId(
      reservationEvent.eventId,
    );
    const releasePublished = await outboxRepository.findByEventId(
      releaseEvent.eventId,
    );
    const reconciliationPublished = await outboxRepository.findByEventId(
      reconciliationEvent.eventId,
    );
    expect(reservationPublished?.publishedAt).not.toBeNull();
    expect(releasePublished?.publishedAt).not.toBeNull();
    expect(reconciliationPublished?.publishedAt).not.toBeNull();
  });

  // CLAUDE.md "Per-Key Ordering": once an earlier row for a Program (messageKey) fails
  // to reach "published" within a poll cycle, a later row for that SAME Program must not
  // be published ahead of it in that cycle - even though the later row's own topic/
  // produce call would otherwise succeed immediately.
  it('does not publish a later same-key event ahead of an earlier one that failed in the same poll cycle', async () => {
    const topic = uniqueTopic('outbox-ordering');
    const programId = 'program-ordering';

    const reservation = buildReservation({ programId });
    const reservationEvent = buildReservationCreatedEvent(
      reservation,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const release = buildRelease({
      programId,
      reservationId: reservation.id,
    });
    const releaseEvent = buildReleaseCreatedEvent(
      release,
      new Date('2026-01-01T00:00:01.000Z'),
    );

    await outboxRepository.create({
      id: reservationEvent.eventId,
      eventId: reservationEvent.eventId,
      topic,
      messageKey: programId,
      eventType: reservationEvent.eventType,
      payload: reservationEvent,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await outboxRepository.create({
      id: releaseEvent.eventId,
      eventId: releaseEvent.eventId,
      topic,
      messageKey: programId,
      eventType: releaseEvent.eventType,
      payload: releaseEvent,
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
    });

    // Force the FIRST (oldest) row's "mark published" step to fail once, without
    // touching Kafka itself - Kafka genuinely receives it, but the row is still
    // considered "not yet published" by this poll cycle's ordering logic.
    const markPublishedSpy = jest
      .spyOn(outboxRepository, 'markPublished')
      .mockRejectedValueOnce(new Error('simulated failure for the first row'));

    const publisher = buildPublisher();
    await publisher.pollOnce();

    const reservationAfterFirstCycle = await outboxRepository.findByEventId(
      reservationEvent.eventId,
    );
    const releaseAfterFirstCycle = await outboxRepository.findByEventId(
      releaseEvent.eventId,
    );
    expect(reservationAfterFirstCycle?.publishedAt).toBeNull();
    // Blocked by ordering - never attempted this cycle, so attempts stays at 0.
    expect(releaseAfterFirstCycle?.attempts).toBe(0);
    expect(releaseAfterFirstCycle?.publishedAt).toBeNull();

    markPublishedSpy.mockRestore();
    await publisher.pollOnce();

    const reservationAfterSecondCycle = await outboxRepository.findByEventId(
      reservationEvent.eventId,
    );
    const releaseAfterSecondCycle = await outboxRepository.findByEventId(
      releaseEvent.eventId,
    );
    expect(reservationAfterSecondCycle?.publishedAt).not.toBeNull();
    expect(releaseAfterSecondCycle?.publishedAt).not.toBeNull();

    // The reservation event is delivered twice (the accepted duplicate window from the
    // first cycle's Kafka-ACKed-but-not-marked-published row); the release event only
    // once, since it was never attempted until it was unblocked.
    const deliveries = await collectMessages(topic, { count: 3 });
    const eventIdsInOrder = deliveries.map(
      (delivery) =>
        (JSON.parse(delivery.value ?? 'null') as { eventId: string }).eventId,
    );
    expect(
      eventIdsInOrder.filter((id) => id === reservationEvent.eventId),
    ).toHaveLength(2);
    expect(
      eventIdsInOrder.filter((id) => id === releaseEvent.eventId),
    ).toHaveLength(1);
    // The release event never appears before the reservation event has appeared at
    // least once.
    expect(eventIdsInOrder.indexOf(releaseEvent.eventId)).toBeGreaterThan(
      eventIdsInOrder.indexOf(reservationEvent.eventId),
    );
  });
});
