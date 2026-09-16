import { ColumnType } from 'kysely';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface ReleaseEventsTable {
  id: PrimaryUuid;
  externalEventId: string;
  topic: string;
  partition: number;
  offset: number;
  eventType: string;
  // No documented wire schema yet for this flow - kept untrusted rather than guessed.
  payload: ColumnType<unknown, string, string>;
  programId: string;
  invoiceId: string;
  reservationId: string;
  releaseId: string;
  receivedAt: Timestamp;
  processedAt: Timestamp | null;
}
