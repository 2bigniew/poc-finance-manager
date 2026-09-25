import { Money } from '@app/modules/domain/shared/money/money';

// Redefined independently of ReconciliationsTable's ReconciliationStatus (database/
// types) rather than imported from it - domain entities do not depend on persistence
// types; repositories own that mapping direction (ARCHITECTURE.md). FAILED is part of
// the persisted schema's contract but is never written by the automated consumer path
// (see reconciliations.service.ts) - a genuine processing failure rolls the transaction
// back instead, so it stays safely retryable rather than being recorded as a permanent
// FAILED audit row. It remains available here for schema fidelity / future manual use.
export type ReconciliationStatus = 'APPLIED' | 'IGNORED_STALE' | 'FAILED';

// An immutable audit record of one authoritative treasury capacity snapshot for one
// Program (BUSINESS.md "Reconciliation Entity"). Never updated after creation.
export interface Reconciliation {
  id: string;
  batchId: string;
  externalEventId: string;
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: Money; // always USD
  effectiveAt: Date;
  status: ReconciliationStatus;
  createdAt: Date;
  updatedAt: Date;
}
