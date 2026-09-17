import { ColumnType } from 'kysely';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface ReservationEventsTable {
  id: PrimaryUuid;
  externalEventId: string;
  topic: string;
  partition: number;
  // Kept as a decimal string, not `number`: Kafka offsets are 64-bit and the app's global
  // int8 type parser (kysely.provider.ts) would otherwise silently narrow them to a
  // JS number, risking precision loss (INFRASTRUCTURE.md; matches
  // KafkaConsumedMessage.offset in broker-kafka.types.ts). The column itself is `text`,
  // not `bigint`, so that global parser never applies to it.
  offset: string;
  eventType: string;
  // No documented wire schema yet for this flow - kept untrusted rather than guessed.
  payload: ColumnType<unknown, string, string>;
  programId: string;
  invoiceId: string;
  reservationId: string;
  receivedAt: Timestamp;
  processedAt: Timestamp | null;
}
