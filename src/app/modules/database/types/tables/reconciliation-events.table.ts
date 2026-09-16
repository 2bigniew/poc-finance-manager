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
  offset: number;
  eventType: string;
  payload: JSONColumnType<ReconciliationEventPayload>;
  programId: string;
  batchId: string;
  sourceVersion: number;
  receivedAt: Timestamp;
  processedAt: Timestamp | null;
}
