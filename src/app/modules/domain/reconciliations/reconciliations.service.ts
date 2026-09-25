import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReconciliationProcessingError } from './exceptions/reconciliation-processing.error';
import {
  buildReconciliationAppliedEvent,
  RECONCILIATION_EVENTS_TOPIC,
} from './events/reconciliation-applied.event';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';
import { Reconciliation, ReconciliationStatus } from './reconciliation.entity';
import {
  isUniqueViolation,
  ReconciliationsRepository,
} from './reconciliations.repository';
import {
  BulkReconciliationInput,
  ReconcileProgramEntryInput,
} from './reconciliations.message-mapper';

// Identifies the physical Kafka record a batch of entries was read from - carried
// through for the inbox row's topic/partition/offset columns (CLAUDE.md section 27:
// "Include enough information to identify... Kafka topic, partition, offset").
export interface KafkaEnvelopeContext {
  topic: string;
  partition: number;
  offset: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Deterministic per-entry identity, stable across redelivery of the exact same entry
// (CLAUDE.md section 21: "derive an entry identity from externalEventId/batchId +
// programId, or use the existing per-entry event ID if the message contract already
// provides one"). BUSINESS.md's wire contract has no per-entry externalEventId field
// (only batchId + programs[]), so this is derived rather than trusted from the wire.
// sourceVersion is included so the SAME Program appearing twice in one bulk message
// with two DIFFERENT sourceVersions is treated as two distinct, independently-dedupable
// entries instead of colliding (CLAUDE.md section 37); an exact redelivery of the same
// entry (same batchId+programId+sourceVersion) always derives the same id.
function deriveExternalEventId(
  batchId: string,
  programId: string,
  sourceVersion: number,
): string {
  return `${batchId}:${programId}:${sourceVersion}`;
}

@Injectable()
export class ReconciliationsService {
  private readonly logger = new Logger(ReconciliationsService.name);

  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
    private readonly reconciliationsRepository: ReconciliationsRepository,
    private readonly reconciliationEventsRepository: ReconciliationEventsRepository,
    private readonly programsService: ProgramsService,
    private readonly outboxRepository: OutboxRepository,
  ) {}

  // Bulk entry point (CLAUDE.md section 20): each Program entry commits atomically and
  // independently - NOT wrapped in one giant transaction. Entries are processed
  // sequentially, never concurrently for the same batch (section 36), and processing
  // continues past a single entry's failure so unrelated Programs in the same message
  // are not blocked by it (section 42: "if processing continues after B, C may commit
  // independently"). If any entry fails, this throws so the Kafka consumer runner
  // retries the whole message - already-applied entries are protected by per-entry
  // idempotency, so the retry only actually re-does the failed ones (section 22/23).
  async reconcileBulk(
    input: BulkReconciliationInput,
    envelope: KafkaEnvelopeContext,
  ): Promise<void> {
    const failures: { programId: string; error: unknown }[] = [];

    for (const entry of input.entries) {
      try {
        await this.reconcileProgramEntry(entry, envelope);
      } catch (error) {
        failures.push({ programId: entry.programId, error });
        this.logger.warn(
          `Reconciliation entry failed (batch=${input.batchId}, program=${entry.programId}, sourceVersion=${entry.sourceVersion}): ${toErrorMessage(error)}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new ReconciliationProcessingError(
        `${failures.length} of ${input.entries.length} reconciliation entries failed in batch "${input.batchId}" (programs: ${failures.map((failure) => failure.programId).join(', ')}).`,
      );
    }
  }

  // The atomic per-entry building block (CLAUDE.md section 19).
  async reconcileProgramEntry(
    entry: ReconcileProgramEntryInput,
    envelope: KafkaEnvelopeContext,
  ): Promise<Reconciliation> {
    const externalEventId = deriveExternalEventId(
      entry.batchId,
      entry.programId,
      entry.sourceVersion,
    );
    const now = new Date();

    try {
      return await this.runReconcileTransaction(
        entry,
        envelope,
        externalEventId,
        now,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // A genuinely concurrent transaction won the race for this exact entry and
      // committed first (both transactions passed the pre-lock dedup check in step 1
      // before either had committed). PostgreSQL has already rolled this transaction
      // back in full at this point - re-fetching now, outside any transaction, is safe
      // (unlike catching this inside the transaction/repository: once one statement in
      // a PostgreSQL transaction fails, the whole transaction is aborted and every
      // subsequent statement on it fails too, so recovery cannot happen on the same
      // `trx`). Reconciliation is an idempotent command (CLAUDE.md section 16-17), so
      // the winning transaction's result is returned rather than propagating the race
      // as an error.
      const existing =
        await this.reconciliationsRepository.findByExternalEventId(
          externalEventId,
        );
      if (existing) {
        return existing;
      }

      throw error;
    }
  }

  private async runReconcileTransaction(
    entry: ReconcileProgramEntryInput,
    envelope: KafkaEnvelopeContext,
    externalEventId: string,
    now: Date,
  ): Promise<Reconciliation> {
    return this.db.transaction().execute(async (trx) => {
      // Step 1: fast dedup check BEFORE locking Program. The inbox record and its
      // domain mutation are always committed together in the same transaction (step 4
      // below; INFRASTRUCTURE.md "Idempotent Consumption / Inbox"), so finding a row
      // here means this exact entry already fully completed - skip reprocessing and
      // avoid taking the Program lock entirely (CLAUDE.md section 25).
      const existingEvent =
        await this.reconciliationEventsRepository.findByExternalEventId(
          externalEventId,
          trx,
        );
      if (existingEvent) {
        const existingReconciliation =
          await this.reconciliationsRepository.findByExternalEventId(
            externalEventId,
            trx,
          );
        if (existingReconciliation) {
          return existingReconciliation;
        }

        // Inbox and audit rows are written atomically in the same transaction; seeing
        // one without the other is a genuine invariant violation, not a retry - fail
        // loudly rather than silently reprocessing (CLAUDE.md section 14).
        throw new ReconciliationProcessingError(
          `Reconciliation inbox row exists for "${externalEventId}" without a matching audit record.`,
        );
      }

      // Step 2: lock Program - the common serialization point shared with Reservation
      // creation and Release (CLAUDE.md section 14-16).
      const program = await this.programsService.findByIdForUpdate(
        entry.programId,
        trx,
      );
      if (!program) {
        // Unknown Program is a typed processing failure, not a silently-ignored or
        // implicitly-created entity (CLAUDE.md section 29). This throws BEFORE
        // anything is written, so nothing is dedup-recorded and the entry remains
        // safely retryable if the Program is created later.
        throw new ProgramNotFoundError(entry.programId);
      }

      // Step 3: sourceVersion decision (BUSINESS.md Bulk Reconciliation: "incoming
      // sourceVersion <= treasuryVersion -> ignore as stale or duplicate; incoming
      // sourceVersion > treasuryVersion -> replace treasury-owned totalCapacityUsd,
      // set treasuryVersion"). Local Reservations/Releases/Invoices are never touched
      // here (CLAUDE.md section 6) - available capacity is recalculated on read from
      // the unchanged ACTIVE Reservation set (section 7).
      let status: ReconciliationStatus;
      if (entry.sourceVersion <= program.treasuryVersion) {
        status = 'IGNORED_STALE';
      } else {
        status = 'APPLIED';
        if (entry.sourceVersion > program.treasuryVersion + 1) {
          // Version gap: this authoritative snapshot is accepted anyway and subsumes
          // the missing earlier versions (BUSINESS.md: "A reconciliation snapshot
          // subsumes missing treasury capacity events up to its sourceVersion") - this
          // is an operational/observability signal, not a processing failure
          // (CLAUDE.md section 12/31).
          this.logger.warn(
            `Reconciliation version gap for program ${entry.programId}: expected next version ${program.treasuryVersion + 1}, received ${entry.sourceVersion} (batch="${entry.batchId}") - accepting as an authoritative snapshot; earlier missing versions are subsumed.`,
          );
        }

        const updated = await this.programsService.applyReconciliation(
          entry.programId,
          program.treasuryVersion,
          {
            totalCapacityUsdAmount: entry.totalCapacityUsd,
            treasuryVersion: entry.sourceVersion,
            updatedAt: now,
          },
          trx,
        );
        if (!updated) {
          // Unreachable under normal operation: the Program row lock held since step 2
          // guarantees no concurrent writer could have changed treasuryVersion between
          // the check above and this write.
          throw new ReconciliationProcessingError(
            `Program ${entry.programId} treasuryVersion changed unexpectedly while locked (expected ${program.treasuryVersion}).`,
          );
        }
      }

      // Step 4: persist audit + inbox atomically (INFRASTRUCTURE.md: "The inbox record
      // and domain mutation MUST be committed in the same PostgreSQL transaction").
      const reconciliation = await this.reconciliationsRepository.create(
        {
          id: randomUUID(),
          batchId: entry.batchId,
          externalEventId,
          programId: entry.programId,
          sourceVersion: entry.sourceVersion,
          totalCapacityUsd: entry.totalCapacityUsd,
          effectiveAt: entry.effectiveAt,
          status,
          createdAt: now,
          updatedAt: now,
        },
        trx,
      );
      await this.reconciliationEventsRepository.create(
        {
          id: randomUUID(),
          externalEventId,
          topic: envelope.topic,
          partition: envelope.partition,
          offset: envelope.offset,
          eventType: 'treasury.reconciliation',
          payload: {
            programId: entry.programId,
            sourceVersion: entry.sourceVersion,
            totalCapacityUsd: entry.totalCapacityUsd,
            effectiveAt: entry.effectiveAt.toISOString(),
          },
          programId: entry.programId,
          batchId: entry.batchId,
          sourceVersion: entry.sourceVersion,
          receivedAt: now,
          processedAt: now,
        },
        trx,
      );

      // Transactional outbox write, APPLIED only (CLAUDE.md "Reconciliation Event
      // Contract": "Do not emit APPLIED events for stale/ignored reconciliation") -
      // commits atomically with the Program/Reconciliation/inbox writes above. Never
      // reached on a redelivered/duplicate entry, since those short-circuit earlier
      // (step 1's inbox dedup check, or reconcileProgramEntry's unique-violation
      // recovery path) without re-running this transaction body.
      if (status === 'APPLIED') {
        const event = buildReconciliationAppliedEvent(reconciliation, now);
        await this.outboxRepository.create(
          {
            id: event.eventId,
            eventId: event.eventId,
            topic: RECONCILIATION_EVENTS_TOPIC,
            messageKey: entry.programId,
            eventType: event.eventType,
            payload: event,
            createdAt: now,
            updatedAt: now,
          },
          trx,
        );
      }

      this.logger.log(
        `Reconciliation ${status} for program ${entry.programId}: sourceVersion=${entry.sourceVersion} (previous treasuryVersion=${program.treasuryVersion}, batch="${entry.batchId}")`,
      );

      return reconciliation;
    });
  }
}
