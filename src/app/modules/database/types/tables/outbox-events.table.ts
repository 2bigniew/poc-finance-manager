import { ColumnType } from 'kysely';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface OutboxEventsTable {
  id: PrimaryUuid;
  eventId: string;
  topic: string;
  messageKey: string | null;
  eventType: string;
  // Shared across every future domain event type - genuinely unknown here by design.
  payload: ColumnType<unknown, string, string>;
  attempts: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
}
