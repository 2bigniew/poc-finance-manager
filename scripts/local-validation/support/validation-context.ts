import { ApiClient } from './api-client';
import { Compose } from './compose';
import { DatabaseProbe, DbRow } from './database-probe';
import { KafkaProbe } from './kafka-probe';
import { Redactor } from './redactor';
import { ScenarioRunner } from './scenario-runner';

export interface ValidationOptions {
  iterations: number;
  build: boolean;
  repoChecks: boolean;
  baseUrl: string;
  kafkaBrokers: string[];
  reportDir: string;
}

// A Program created by this validation run whose final state is re-checked later to
// prove persistence across iterations, restarts, and migration re-runs.
export interface TrackedProgram {
  runId: string;
  programId: string;
  expectedTotalUsd: string;
  expectedReservedUsd: string;
  expectedTreasuryVersion: number;
}

export interface MigrationRun {
  label: string;
  exitCode: number;
  output: string[];
  appliedBefore: string[];
  appliedAfter: string[];
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
}

export interface ValidationContext {
  options: ValidationOptions;
  projectDir: string;
  timestampTag: string;
  startedAt: Date;
  compose: Compose;
  db: DatabaseProbe;
  kafka: KafkaProbe;
  api: ApiClient;
  redactor: Redactor;
  runner: ScenarioRunner;
  trackedPrograms: TrackedProgram[];
  baseline: {
    counts: Record<string, number>;
    migrations: string[];
    preExistingPrograms: DbRow[];
  } | null;
  infrastructure: Record<string, unknown>;
  migrationRuns: MigrationRun[];
}

export const APP_CONSUMER_GROUP = 'poc-finance-manager';
export const TREASURY_TOPIC = 'treasury.reconciliation';
export const RESERVATION_EVENTS_TOPIC = 'reservations.events';
export const RELEASE_EVENTS_TOPIC = 'releases.events';
export const RECONCILIATION_EVENTS_TOPIC = 'reconciliations.events';

export function runIdFor(ctx: ValidationContext, suffix: string): string {
  return `validation-${ctx.timestampTag}-${suffix}`;
}
