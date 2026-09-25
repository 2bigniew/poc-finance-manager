import { DecimalAmount } from '../money.types';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export type ReconciliationStatus = 'APPLIED' | 'IGNORED_STALE' | 'FAILED';

export interface ReconciliationsTable {
  id: PrimaryUuid;
  batchId: string;
  externalEventId: string;
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: DecimalAmount;
  effectiveAt: Timestamp;
  status: ReconciliationStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
