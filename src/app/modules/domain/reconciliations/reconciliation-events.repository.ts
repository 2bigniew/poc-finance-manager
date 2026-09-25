import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import {
  ReconciliationEventPayload,
  ReconciliationEventsTable,
} from '@app/modules/database/types/tables/reconciliation-events.table';

// The inbox/idempotency record for one processed reconciliation entry
// (INFRASTRUCTURE.md "Idempotent Consumption / Inbox"). Distinct from `Reconciliation`
// (reconciliation.entity.ts), which is the business audit record - this is
// transport/dedup metadata (topic/partition/offset/externalEventId).
export interface ReconciliationEventRecord {
  id: string;
  externalEventId: string;
  topic: string;
  partition: number;
  offset: string;
  eventType: string;
  payload: ReconciliationEventPayload;
  programId: string;
  batchId: string;
  sourceVersion: number;
  receivedAt: Date;
  processedAt: Date | null;
}

interface CreateReconciliationEventRow {
  id: string;
  externalEventId: string;
  topic: string;
  partition: number;
  offset: string;
  eventType: string;
  payload: ReconciliationEventPayload;
  programId: string;
  batchId: string;
  sourceVersion: number;
  receivedAt: Date;
  processedAt: Date;
}

// Only create/findByExternalEventId are implemented - the operations actually needed by
// this step (CLAUDE.md section 17 equivalent). The inbox record and its domain mutation
// are always written in the same transaction (see reconciliations.service.ts), so a row
// only ever exists in the "fully processed" state - there is no separate
// received-but-not-yet-processed phase to model, unlike a design where inbox
// registration and processing are two separate steps.
@Injectable()
export class ReconciliationEventsRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  // Deliberately does NOT catch/recover from a UNIQUE(external_event_id) violation here
  // - see ReconciliationsRepository's isUniqueViolation comment for why that recovery
  // can only safely happen once the enclosing transaction has fully rolled back. In
  // practice this insert only ever runs after ReconciliationsRepository.create has
  // already succeeded in the same transaction (reconciliations.service.ts step 4), so a
  // violation here on the exact same externalEventId should not occur - but this method
  // still must not attempt an unsafe same-transaction recovery if it ever did.
  async create(
    row: CreateReconciliationEventRow,
    executor: Kysely<Database> = this.db,
  ): Promise<ReconciliationEventRecord> {
    // JSONColumnType's Insert type is `string` (Kysely serializes/deserializes JSON
    // columns as strings on the way in, parsing them back to the Select object type on
    // the way out) - the payload object must be stringified explicitly here, mirroring
    // how OutboxEventsTable.payload (ColumnType<unknown, string, string>) is written
    // elsewhere in this codebase.
    const inserted = await executor
      .insertInto('reconciliationEvents')
      .values({ ...row, payload: JSON.stringify(row.payload) })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toEntity(inserted);
  }

  async findByExternalEventId(
    externalEventId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<ReconciliationEventRecord | null> {
    const row = await executor
      .selectFrom('reconciliationEvents')
      .selectAll()
      .where('externalEventId', '=', externalEventId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  private toEntity(
    row: Selectable<ReconciliationEventsTable>,
  ): ReconciliationEventRecord {
    return {
      id: row.id,
      externalEventId: row.externalEventId,
      topic: row.topic,
      partition: row.partition,
      offset: row.offset,
      eventType: row.eventType,
      payload: row.payload,
      programId: row.programId,
      batchId: row.batchId,
      sourceVersion: row.sourceVersion,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
    };
  }
}
