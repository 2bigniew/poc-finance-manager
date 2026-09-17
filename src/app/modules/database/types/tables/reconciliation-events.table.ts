import { JSONColumnType } from 'kysely';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

// One BulkReconciliationMessage program entry, as received on the wire (BUSINESS.md).
export interface ReconciliationEventPayload {
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: string;
  effectiveAt: string;
}

export interface ReconciliationEventsTable {
  id: PrimaryUuid;
  externalEventId: string;
  topic: string;
  partition: number;
  // See ReservationEventsTable.offset - kept as a decimal string, backed by `text`, to
  // avoid the app's global int8->Number parser risking precision loss on 64-bit offsets.
  offset: string;
  eventType: string;
  payload: JSONColumnType<ReconciliationEventPayload>;
  programId: string;
  batchId: string;
  sourceVersion: number;
  receivedAt: Timestamp;
  processedAt: Timestamp | null;
}
