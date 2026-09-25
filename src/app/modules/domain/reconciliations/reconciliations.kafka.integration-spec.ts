import { randomUUID } from 'node:crypto';
import { Injectable, INestApplication, Provider } from '@nestjs/common';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import {
  KafkaConsumedMessage,
  KafkaRetryOptions,
} from '@app/modules/broker-kafka/broker-kafka.types';
import { ConsumeOneMessage } from '@app/modules/broker-kafka/decorators/consume-one-message.decorator';
import {
  bootstrapKafkaTestApp,
  collectMessages,
  createTestTopics,
  fetchCommittedOffset,
  produceRaw,
  uniqueTopic,
  waitUntil,
} from '@app/modules/broker-kafka/test-support/kafka-integration-test.util';
import { ProgramsRepository } from '@app/modules/domain/programs/programs.repository';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';
import { ReconciliationsRepository } from './reconciliations.repository';
import { ReconciliationsService } from './reconciliations.service';
import { mapBulkReconciliationMessage } from './reconciliations.message-mapper';

interface ReservationsRepositoryLike {
  sumActiveByProgram: (
    programId: string,
  ) => Promise<{ amount: string; currency: string }>;
}

// Builds the REAL ReconciliationsService (real Postgres, no mocks) exactly like
// reconciliations.integration-spec.ts's buildReconciliationsService - shared logic
// factored out would need cross-file exports for no real benefit at this project's
// size, so it is duplicated here per that file's own established convention.
function buildRealReconciliationsService(db: Kysely<Database>): {
  reconciliationsService: ReconciliationsService;
  programsService: ProgramsService;
} {
  const programsRepository = new ProgramsRepository(db);
  const reconciliationsRepository = new ReconciliationsRepository(db);
  const reconciliationEventsRepository = new ReconciliationEventsRepository(db);
  const outboxRepository = new OutboxRepository(db);
  const reservationsRepository: ReservationsRepositoryLike = {
    sumActiveByProgram: async (programId: string) => {
      const result = await db
        .selectFrom('reservations')
        .select((eb) =>
          eb.fn
            .coalesce(eb.fn.sum<string>('convertedAmountUsd'), eb.val('0.0000'))
            .as('total'),
        )
        .where('programId', '=', programId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirstOrThrow();
      return { amount: result.total, currency: 'USD' };
    },
  };
  const programsService = new ProgramsService(
    programsRepository,
    reservationsRepository,
  );
  const reconciliationsService = new ReconciliationsService(
    db,
    reconciliationsRepository,
    reconciliationEventsRepository,
    programsService,
    outboxRepository,
  );

  return { reconciliationsService, programsService };
}

// A throwaway @ConsumeOneMessage provider bound to a per-test unique topic (TESTING.md
// "Kafka Topic Isolation... MUST use isolated topic names"), running the SAME
// validation (mapBulkReconciliationMessage) and business logic
// (ReconciliationsService.reconcileBulk) the real, fixed-topic
// ReconciliationsConsumerService uses - exercising the real broker discovery/retry/
// offset-commit/DLQ machinery against real business logic and real Postgres, the same
// pattern broker-kafka's own Kafka integration tests use for isolation
// (createSingleTestConsumer), just with real domain logic as the handler body instead
// of a test spy.
function createReconciliationTestConsumer(
  topic: string,
  reconciliationsService: ReconciliationsService,
  retry?: Partial<KafkaRetryOptions>,
): Provider {
  @Injectable()
  class GeneratedReconciliationConsumer {
    @ConsumeOneMessage({ topic, retry })
    async consume(message: KafkaConsumedMessage<unknown>): Promise<void> {
      const input = mapBulkReconciliationMessage(message);
      await reconciliationsService.reconcileBulk(input, {
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
      });
    }
  }

  const instance = new GeneratedReconciliationConsumer();
  return { provide: GeneratedReconciliationConsumer, useValue: instance };
}

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `reconciliations-kafka-${id}@example.test`,
      passwordHash: 'hashed-password-placeholder',
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

async function createTestProgram(
  db: Kysely<Database>,
  totalCapacityUsdAmount: string,
  treasuryVersion = 0,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('programs')
    .values({
      id,
      name: `Program ${id}`,
      originalCapacityAmount: totalCapacityUsdAmount,
      originalCapacityCurrency: 'USD',
      totalCapacityUsdAmount,
      treasuryVersion,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

async function createTestReservation(
  db: Kysely<Database>,
  programId: string,
  createdByUserId: string,
  amount: string,
): Promise<string> {
  const invoiceId = randomUUID();
  const reservationId = randomUUID();
  const now = new Date();

  await db
    .insertInto('invoices')
    .values({
      id: invoiceId,
      externalReference: `INV-${invoiceId}`,
      originalAmount: amount,
      originalCurrency: 'USD',
      convertedAmountUsd: amount,
      conversionRate: '1.000000',
      conversionRateDate: now,
      conversionSource: 'frankfurter.dev',
      status: 'RESERVED',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  await db
    .insertInto('reservations')
    .values({
      id: reservationId,
      programId,
      invoiceId,
      originalAmount: amount,
      originalCurrency: 'USD',
      convertedAmountUsd: amount,
      conversionRate: '1.000000',
      conversionRateDate: now,
      conversionSource: 'frankfurter.dev',
      status: 'ACTIVE',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return reservationId;
}

describe('Reconciliation consumer (Kafka + Postgres integration)', () => {
  const apps: INestApplication[] = [];
  let db: Kysely<Database>;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    userId = await createTestUser(db);
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await db.deleteFrom('outboxEvents').execute();
    await db.deleteFrom('reconciliationEvents').execute();
    await db.deleteFrom('reconciliations').execute();
    await db.deleteFrom('reservations').execute();
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
    await db.deleteFrom('programs').execute();
  });

  it('consumes a bulk reconciliation message, updates the Program, and commits the offset only after success', async () => {
    const topic = uniqueTopic('reconciliation-single-success');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    const programId = await createTestProgram(db, '1000', 3);
    const { reconciliationsService, programsService } =
      buildRealReconciliationsService(db);
    const consumer = createReconciliationTestConsumer(
      topic,
      reconciliationsService,
    );

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      {
        key: 'batch-1',
        value: JSON.stringify({
          batchId: 'batch-1',
          programs: [
            {
              programId,
              sourceVersion: 4,
              totalCapacityUsd: '1500.0000',
              effectiveAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      },
    ]);

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );

    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('1500.0000');
    expect(program.treasuryVersion).toBe(4);
  });

  it('processes a realistic bulk message with multiple Program entries independently, leaving Reservations unchanged', async () => {
    const topic = uniqueTopic('reconciliation-bulk-success');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    const programA = await createTestProgram(db, '1000', 0);
    const programB = await createTestProgram(db, '2000', 0);
    const reservationId = await createTestReservation(
      db,
      programA,
      userId,
      '300',
    );
    const reservationBefore = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();

    const { reconciliationsService, programsService } =
      buildRealReconciliationsService(db);
    const consumer = createReconciliationTestConsumer(
      topic,
      reconciliationsService,
    );
    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      {
        key: 'batch-bulk',
        value: JSON.stringify({
          batchId: 'batch-bulk',
          programs: [
            {
              programId: programA,
              sourceVersion: 1,
              totalCapacityUsd: '1100.0000',
              effectiveAt: '2026-01-01T00:00:00.000Z',
            },
            {
              programId: programB,
              sourceVersion: 1,
              totalCapacityUsd: '2200.0000',
              effectiveAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      },
    ]);

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );

    const a = await programsService.get(programA);
    expect(a.totalCapacityUsd.amount).toBe('1100.0000');
    const b = await programsService.get(programB);
    expect(b.totalCapacityUsd.amount).toBe('2200.0000');

    const reservationAfter = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservationAfter).toEqual(reservationBefore);

    const summary = await programsService.getCapacitySummary(a);
    expect(summary.reservedCapacityUsd.amount).toBe('300.0000');
    expect(summary.availableCapacityUsd.amount).toBe('800.0000');
  });

  // Mandatory (CLAUDE.md section 43/45): redelivering an already-fully-processed bulk
  // message must not double-apply it. Simulates "DB commit succeeded, Kafka offset
  // commit failed" by simply republishing the identical message to the SAME topic/
  // consumer group after the first delivery has already committed - per-entry inbox
  // dedup must make the second delivery a safe no-op.
  it('does not double-apply a redelivered bulk message (DB commit + Kafka offset failure safety)', async () => {
    const topic = uniqueTopic('reconciliation-redelivery');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    const programId = await createTestProgram(db, '1000', 0);
    const { reconciliationsService, programsService } =
      buildRealReconciliationsService(db);
    const consumer = createReconciliationTestConsumer(
      topic,
      reconciliationsService,
    );
    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    const message = {
      key: 'batch-redelivery',
      value: JSON.stringify({
        batchId: 'batch-redelivery',
        programs: [
          {
            programId,
            sourceVersion: 1,
            totalCapacityUsd: '1200.0000',
            effectiveAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    };

    await produceRaw(topic, [message]);
    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );

    const afterFirst = await programsService.get(programId);
    expect(afterFirst.totalCapacityUsd.amount).toBe('1200.0000');
    expect(afterFirst.treasuryVersion).toBe(1);

    // Redeliver the exact same message (simulating offset-commit failure / consumer
    // restart before the offset was durably committed).
    await produceRaw(topic, [message]);
    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '2',
    );

    const afterRedelivery = await programsService.get(programId);
    expect(afterRedelivery.totalCapacityUsd.amount).toBe('1200.0000');
    expect(afterRedelivery.treasuryVersion).toBe(1);

    const rows = await db
      .selectFrom('reconciliations')
      .selectAll()
      .where('programId', '=', programId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('fails processing on a malformed payload and dead-letters it like any other permanent failure', async () => {
    const topic = uniqueTopic('reconciliation-malformed');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }, { topic: `${topic}.dlq` }]);

    const { reconciliationsService } = buildRealReconciliationsService(db);
    const consumer = createReconciliationTestConsumer(
      topic,
      reconciliationsService,
      { attempts: 1, delayMs: 10 },
    );
    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'bad-batch', value: JSON.stringify({ nonsense: true }) },
    ]);

    const deadLetterMessages = await collectMessages(`${topic}.dlq`, {
      count: 1,
    });
    expect(deadLetterMessages).toHaveLength(1);
    expect(deadLetterMessages[0]?.key).toBe('bad-batch');

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );
  });

  // An invalid dead-letter topic suffix (a space) makes the DLQ publish itself fail
  // deterministically after retries are exhausted, so the offset is left uncommitted
  // (mirrors broker-kafka.consumer-single.integration-spec.ts's own technique for this
  // exact scenario) instead of racing against undefined broker auto-topic-creation
  // behavior for a real DLQ topic.
  it('leaves the offset uncommitted when a Program-missing entry keeps failing and dead-lettering also fails', async () => {
    const topic = uniqueTopic('reconciliation-program-missing');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    const missingProgramId = randomUUID();
    const { reconciliationsService, programsService } =
      buildRealReconciliationsService(db);
    const consumer = createReconciliationTestConsumer(
      topic,
      reconciliationsService,
      { attempts: 1, delayMs: 10 },
    );
    const app = await bootstrapKafkaTestApp([consumer], {
      consumerGroup,
      deadLetterTopicSuffix: ' invalid dlq suffix!',
    });
    apps.push(app);

    await produceRaw(topic, [
      {
        key: 'batch-missing',
        value: JSON.stringify({
          batchId: 'batch-missing',
          programs: [
            {
              programId: missingProgramId,
              sourceVersion: 1,
              totalCapacityUsd: '100.0000',
              effectiveAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      },
    ]);

    // Give the single attempt + failed DLQ publish time to run to completion. Kafka's
    // admin API reports "-1" (not undefined) for a partition with no committed offset
    // yet - matches broker-kafka.consumer-single.integration-spec.ts's own assertion
    // style for this exact scenario.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const committedOffset = await fetchCommittedOffset(consumerGroup, topic);
    expect(committedOffset === undefined || committedOffset === '-1').toBe(
      true,
    );

    // The Program still does not exist and was never created/mutated - no Reconciliation
    // or inbox row was left behind either, so a future retry (once the Program exists)
    // would process this entry fresh rather than treating it as already-handled.
    await expect(programsService.get(missingProgramId)).rejects.toThrow();
    const rows = await db
      .selectFrom('reconciliations')
      .selectAll()
      .where('programId', '=', missingProgramId)
      .execute();
    expect(rows).toHaveLength(0);
  });
});
