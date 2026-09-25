// Untrusted wire shape as received from Kafka on the bulk reconciliation topic
// (BUSINESS.md "Bulk Reconciliation": "BulkReconciliationMessage -> batchId, programs[]
// -> programId, sourceVersion, totalCapacityUsd, effectiveAt"). Deliberately has NO
// per-entry externalEventId field - BUSINESS.md's wire contract does not define one, so
// reconciliations.message-mapper.ts derives a deterministic per-entry identity instead
// of trusting one from the wire (see reconciliations.service.ts's deriveExternalEventId).
//
// Every field is `unknown`-adjacent (string/number as received, not yet validated) -
// nothing here is trusted until reconciliations.message-mapper.ts validates it
// (CLAUDE.md: "External responses are untrusted and must be validated/mapped before
// they enter domain logic").
export interface TreasuryProgramSnapshot {
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: string;
  effectiveAt: string;
}

export interface BulkReconciliationMessage {
  batchId: string;
  programs: TreasuryProgramSnapshot[];
}
