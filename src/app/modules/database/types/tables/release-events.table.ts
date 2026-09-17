import { ColumnType } from 'kysely';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface ReleaseEventsTable {
  id: PrimaryUuid;
  externalEventId: string;
  topic: string;
  partition: number;
  // See ReservationEventsTable.offset - kept as a decimal string, backed by `text`, to
  // avoid the app's global int8->Number parser risking precision loss on 64-bit offsets.
  offset: string;
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
