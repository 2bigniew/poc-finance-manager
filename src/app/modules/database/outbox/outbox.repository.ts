import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxEventsTable } from '@app/modules/database/types/tables/outbox-events.table';

// One durable pending-outbound-delivery record (INFRASTRUCTURE.md "Transactional
// Outbox"). Distinct from the domain-owned ReservationEvent/ReleaseEvent/
// ReconciliationEvent inbox tables (CLAUDE.md "Event Table Meaning") - this table only
// ever represents "has this logical event been handed to Kafka and acknowledged yet",
// never business/domain state.
export interface OutboxRecord {
  id: string;
  eventId: string;
  topic: string;
  messageKey: string | null;
  eventType: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

export interface CreateOutboxEventRow {
  id: string;
  eventId: string;
  topic: string;
  messageKey: string | null;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

// Owns Kysely access to outbox_events only. No Kafka calls, no event serialization
// decisions, no retry loop - those belong to OutboxPublisherService
// (CLAUDE.md "OutboxRepository"). create/findUnpublishedBatch/incrementAttempts/
// markPublished/findByEventId are exactly the operations the publisher and the
// transactional domain writers (Reservations/Releases/Reconciliations) need.
@Injectable()
export class OutboxRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  // Called by a domain service's OWN business transaction (Reservation/Release/
  // Reconciliation), never on its own - `executor` is expected to be that caller's
  // `trx` so the outbox row commits atomically with the business state it describes
  // (INFRASTRUCTURE.md: "The domain change and outbox insert MUST happen in the same
  // PostgreSQL transaction"). Every new row starts unpublished with zero attempts.
  async create(
    row: CreateOutboxEventRow,
    executor: Kysely<Database> = this.db,
  ): Promise<OutboxRecord> {
    const inserted = await executor
      .insertInto('outboxEvents')
      .values({
        id: row.id,
        eventId: row.eventId,
        topic: row.topic,
        messageKey: row.messageKey,
        eventType: row.eventType,
        payload: JSON.stringify(row.payload),
        attempts: 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        publishedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toEntity(inserted);
  }

  // Oldest-first (createdAt asc, id asc as a stable tiebreaker) over the partial
  // `outbox_events_unpublished_idx` index (CLAUDE.md "Loading Unpublished Events") - the
  // publisher relies on this order to preserve same-messageKey ordering within a batch.
  async findUnpublishedBatch(
    limit: number,
    executor: Kysely<Database> = this.db,
  ): Promise<OutboxRecord[]> {
    const rows = await executor
      .selectFrom('outboxEvents')
      .selectAll()
      .where('publishedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  // Recorded before every publication attempt, success or failure (CLAUDE.md
  // "Attempts Tracking": one explicit, documented convention - never mixed with
  // "increment only on failure").
  async incrementAttempts(
    id: string,
    updatedAt: Date,
    executor: Kysely<Database> = this.db,
  ): Promise<void> {
    await executor
      .updateTable('outboxEvents')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        updatedAt,
      }))
      .where('id', '=', id)
      .execute();
  }

  // `WHERE published_at IS NULL` guards against double-marking an already-published row
  // if two publisher runs somehow raced on the same id - the row's core identity
  // (eventId/topic/messageKey/eventType/payload) is never touched here (CLAUDE.md
  // "Mark Published": "Do not mutate... after publication").
  async markPublished(
    id: string,
    publishedAt: Date,
    executor: Kysely<Database> = this.db,
  ): Promise<OutboxRecord | null> {
    const updated = await executor
      .updateTable('outboxEvents')
      .set({ publishedAt, updatedAt: publishedAt })
      .where('id', '=', id)
      .where('publishedAt', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return updated ? this.toEntity(updated) : null;
  }

  async findByEventId(
    eventId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<OutboxRecord | null> {
    const row = await executor
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventId', '=', eventId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  private toEntity(row: Selectable<OutboxEventsTable>): OutboxRecord {
    return {
      id: row.id,
      eventId: row.eventId,
      topic: row.topic,
      messageKey: row.messageKey,
      eventType: row.eventType,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
    };
  }
}
