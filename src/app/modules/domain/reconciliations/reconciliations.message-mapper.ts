import { KafkaConsumedMessage } from '@app/modules/broker-kafka/broker-kafka.types';
import { isNonNegativeDecimalString } from '@app/modules/domain/shared/money/decimal-math';
import { InvalidReconciliationMessageError } from './exceptions/invalid-reconciliation-message.error';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validated, trusted shape - the only shape reconciliations.service.ts ever sees. The
// raw Kafka JSON payload never crosses this boundary (CLAUDE.md: "External responses
// are untrusted and must be validated/mapped before they enter domain logic").
export interface ReconcileProgramEntryInput {
  batchId: string;
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: string;
  effectiveAt: Date;
}

export interface BulkReconciliationInput {
  batchId: string;
  entries: ReconcileProgramEntryInput[];
}

// Validates and maps an untrusted Kafka payload into BulkReconciliationInput. Throws
// InvalidReconciliationMessageError on any structural/format problem - the caller (
// ReconciliationsConsumerService) lets this propagate so the message follows the normal
// Kafka retry/DLQ path rather than silently skipping malformed entries (CLAUDE.md
// section 4).
export function mapBulkReconciliationMessage(
  message: KafkaConsumedMessage<unknown>,
): BulkReconciliationInput {
  const payload = message.payload;
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidReconciliationMessageError(
      'Reconciliation message payload must be a JSON object.',
    );
  }

  const { batchId, programs } = payload as Record<string, unknown>;
  if (typeof batchId !== 'string' || batchId.trim().length === 0) {
    throw new InvalidReconciliationMessageError(
      'Reconciliation message is missing a non-empty batchId.',
    );
  }
  if (!Array.isArray(programs) || programs.length === 0) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" is missing a non-empty programs array.`,
    );
  }

  const entries = programs.map((entry, index) =>
    mapEntry(batchId, entry, index),
  );

  return { batchId, entries };
}

function mapEntry(
  batchId: string,
  entry: unknown,
  index: number,
): ReconcileProgramEntryInput {
  if (typeof entry !== 'object' || entry === null) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" entry ${index} must be a JSON object.`,
    );
  }

  const { programId, sourceVersion, totalCapacityUsd, effectiveAt } =
    entry as Record<string, unknown>;

  if (typeof programId !== 'string' || !UUID_PATTERN.test(programId)) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" entry ${index} has an invalid programId.`,
    );
  }
  if (
    typeof sourceVersion !== 'number' ||
    !Number.isInteger(sourceVersion) ||
    sourceVersion < 0
  ) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" entry ${index} (program ${programId}) has an invalid sourceVersion.`,
    );
  }
  if (
    typeof totalCapacityUsd !== 'string' ||
    !isNonNegativeDecimalString(totalCapacityUsd)
  ) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" entry ${index} (program ${programId}) has an invalid totalCapacityUsd.`,
    );
  }
  if (typeof effectiveAt !== 'string' || effectiveAt.trim().length === 0) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" entry ${index} (program ${programId}) is missing effectiveAt.`,
    );
  }
  const effectiveAtDate = new Date(effectiveAt);
  if (Number.isNaN(effectiveAtDate.getTime())) {
    throw new InvalidReconciliationMessageError(
      `Reconciliation batch "${batchId}" entry ${index} (program ${programId}) has an unparseable effectiveAt.`,
    );
  }

  return {
    batchId,
    programId,
    sourceVersion,
    totalCapacityUsd,
    effectiveAt: effectiveAtDate,
  };
}
