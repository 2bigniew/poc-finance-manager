import { randomBytes } from 'node:crypto';
import { ApiResponse } from './api-client';
import { sqlLiteral } from './database-probe';
import { decimalEquals } from './decimal';
import { at, collectKeys, numberAt, stringAt } from './json-path';
import { ScenarioContext } from './scenario-runner';
import {
  TREASURY_TOPIC,
  TrackedProgram,
  ValidationContext,
} from './validation-context';
import { waitFor } from './wait';

// Black-box building blocks shared by scenarios. Each one drives the real HTTP/Kafka
// contract and asserts on the observable result - none of them re-implement business
// rules of the application.

export interface Session {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  password: string;
}

export interface CapacityExpectation {
  total: string;
  reserved: string;
  available: string;
}

function describeBody(ctx: ValidationContext, body: unknown): string {
  const text = JSON.stringify(body) ?? 'undefined';
  return ctx.redactor.redact(
    text.length > 400 ? `${text.slice(0, 400)}...` : text,
  );
}

export function expectStatus(
  ctx: ValidationContext,
  sc: ScenarioContext,
  response: ApiResponse,
  expected: number,
  label: string,
): void {
  sc.check(
    response.status === expected,
    `${label}: expected HTTP ${expected}, got ${response.status} ${describeBody(ctx, response.body)}`,
  );
}

export function requireString(
  sc: ScenarioContext,
  body: unknown,
  path: string,
  label: string,
): string {
  const value = stringAt(body, path);
  sc.check(
    value !== undefined && value.length > 0,
    `${label}: missing "${path}"`,
  );
  return value;
}

export function newPassword(ctx: ValidationContext): string {
  const password = `Val!${randomBytes(18).toString('base64url')}`;
  ctx.redactor.register(password);
  return password;
}

export async function registerAndLogin(
  ctx: ValidationContext,
  sc: ScenarioContext,
  runId: string,
  label = '',
): Promise<Session> {
  const email = `validation+${runId}${label}@example.com`;
  const password = newPassword(ctx);

  const registered = await ctx.api.post('/users/register', { email, password });
  expectStatus(ctx, sc, registered, 201, 'register');
  const userId = requireString(sc, registered.body, 'user.id', 'register');
  for (const token of ['access_token', 'refresh_token']) {
    const value = stringAt(registered.body, token);
    if (value) {
      ctx.redactor.register(value);
    }
  }

  const loggedIn = await ctx.api.post('/users/login', { email, password });
  expectStatus(ctx, sc, loggedIn, 200, 'login');
  const accessToken = requireString(sc, loggedIn.body, 'access_token', 'login');
  const refreshToken = requireString(
    sc,
    loggedIn.body,
    'refresh_token',
    'login',
  );
  ctx.redactor.register(accessToken);
  ctx.redactor.register(refreshToken);

  sc.resource(`userId${label}`, userId);
  return { userId, email, accessToken, refreshToken, password };
}

export function assertNoSensitiveFields(
  sc: ScenarioContext,
  body: unknown,
  password: string,
  label: string,
): void {
  const keys = collectKeys(body);
  for (const forbidden of ['password', 'passwordHash', 'password_hash']) {
    sc.check(!keys.has(forbidden), `${label}: response exposes "${forbidden}"`);
  }
  sc.check(
    !JSON.stringify(body).includes(password),
    `${label}: response echoes the plaintext password`,
  );
}

export async function createProgram(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  name: string,
  capacityUsd: string,
): Promise<string> {
  const response = await ctx.api.post(
    '/programs',
    {
      name,
      originalCapacityAmount: capacityUsd,
      originalCapacityCurrency: 'USD',
      totalCapacityUsdAmount: capacityUsd,
    },
    session.accessToken,
  );
  expectStatus(ctx, sc, response, 201, `create program "${name}"`);
  return requireString(sc, response.body, 'id', 'create program');
}

export async function createInvoice(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  externalReference: string,
  amount: string,
  currency = 'USD',
): Promise<ApiResponse> {
  const response = await ctx.api.post(
    '/invoices',
    { externalReference, amount, currency },
    session.accessToken,
  );
  expectStatus(ctx, sc, response, 201, `create invoice ${externalReference}`);
  requireString(sc, response.body, 'id', 'create invoice');
  return response;
}

export async function getOk(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  path: string,
): Promise<unknown> {
  const response = await ctx.api.get(path, session.accessToken);
  expectStatus(ctx, sc, response, 200, `GET ${path}`);
  return response.body;
}

export function reserve(
  ctx: ValidationContext,
  session: Session,
  programId: string,
  invoiceId: string,
): Promise<ApiResponse> {
  return ctx.api.post(
    `/programs/${programId}/reservations`,
    { invoiceId },
    session.accessToken,
  );
}

export function release(
  ctx: ValidationContext,
  session: Session,
  reservationId: string,
): Promise<ApiResponse> {
  return ctx.api.post(
    `/reservations/${reservationId}/release`,
    undefined,
    session.accessToken,
  );
}

export function capacityOf(program: unknown): CapacityExpectation & {
  treasuryVersion: number | undefined;
} {
  return {
    total: stringAt(program, 'totalCapacityUsd.amount') ?? '?',
    reserved: stringAt(program, 'reservedCapacityUsd.amount') ?? '?',
    available: stringAt(program, 'availableCapacityUsd.amount') ?? '?',
    treasuryVersion: numberAt(program, 'treasuryVersion'),
  };
}

export async function expectCapacity(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  programId: string,
  expected: CapacityExpectation,
  label: string,
): Promise<unknown> {
  const program = await getOk(ctx, sc, session, `/programs/${programId}`);
  const actual = capacityOf(program);
  sc.observe(
    `${label}: total=${actual.total} reserved=${actual.reserved} available=${actual.available} treasuryVersion=${actual.treasuryVersion}`,
  );
  sc.check(
    decimalEquals(actual.total, expected.total) &&
      decimalEquals(actual.reserved, expected.reserved) &&
      decimalEquals(actual.available, expected.available),
    `${label}: expected total=${expected.total} reserved=${expected.reserved} available=${expected.available}, got total=${actual.total} reserved=${actual.reserved} available=${actual.available}`,
  );
  sc.check(
    stringAt(program, 'totalCapacityUsd.currency') === 'USD' &&
      stringAt(program, 'reservedCapacityUsd.currency') === 'USD' &&
      stringAt(program, 'availableCapacityUsd.currency') === 'USD',
    `${label}: capacity values are not all USD`,
  );
  return program;
}

export async function expectStatusField(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  path: string,
  expected: string,
): Promise<unknown> {
  const body = await getOk(ctx, sc, session, path);
  const status = stringAt(body, 'status');
  sc.check(
    status === expected,
    `GET ${path}: expected status ${expected}, got ${status}`,
  );
  return body;
}

export function sameMonetarySnapshot(a: unknown, b: unknown): boolean {
  return (
    decimalEquals(
      at(a, 'originalMoney.amount'),
      stringAt(b, 'originalMoney.amount') ?? 'x',
    ) &&
    stringAt(a, 'originalMoney.currency') ===
      stringAt(b, 'originalMoney.currency') &&
    decimalEquals(
      at(a, 'convertedMoneyUsd.amount'),
      stringAt(b, 'convertedMoneyUsd.amount') ?? 'x',
    ) &&
    stringAt(a, 'convertedMoneyUsd.currency') ===
      stringAt(b, 'convertedMoneyUsd.currency') &&
    stringAt(a, 'conversion.rate') === stringAt(b, 'conversion.rate') &&
    stringAt(a, 'conversion.rateDate') === stringAt(b, 'conversion.rateDate') &&
    stringAt(a, 'conversion.source') === stringAt(b, 'conversion.source')
  );
}

export interface OutboxRow {
  eventId: string;
  eventType: string;
  publishedAt: string | null;
  attempts: number;
}

export async function outboxRowsFor(
  ctx: ValidationContext,
  eventType: string,
  payloadField: string,
  entityId: string,
): Promise<OutboxRow[]> {
  const rows = await ctx.db.query(
    `SELECT event_id, event_type, published_at, attempts
       FROM outbox_events
      WHERE event_type = ${sqlLiteral(eventType)}
        AND payload->'payload'->>${sqlLiteral(payloadField)} = ${sqlLiteral(entityId)}
      ORDER BY created_at`,
  );
  return rows.map((row) => ({
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
    attempts: Number(row.attempts),
  }));
}

// Exactly one outbox row for the entity, eventually published.
export async function expectSingleOutboxEventPublished(
  ctx: ValidationContext,
  sc: ScenarioContext,
  eventType: string,
  payloadField: string,
  entityId: string,
  timeoutMs = 30_000,
): Promise<OutboxRow> {
  const row = await waitFor(
    `${eventType} outbox row for ${entityId} to be published`,
    async () => {
      const rows = await outboxRowsFor(ctx, eventType, payloadField, entityId);
      sc.check(
        rows.length <= 1,
        `${eventType}: expected at most one outbox row for ${entityId}, found ${rows.length}`,
      );
      const [first] = rows;
      return first && first.publishedAt !== null ? first : null;
    },
    { timeoutMs, intervalMs: 500 },
  );
  sc.observe(
    `outbox ${eventType} eventId=${row.eventId} publishedAt=${row.publishedAt} attempts=${row.attempts}`,
  );
  return row;
}

export interface ReconciliationEntry {
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: string;
}

export async function publishReconciliation(
  ctx: ValidationContext,
  batchId: string,
  entries: ReconciliationEntry[],
  key: string,
): Promise<string> {
  const record = await ctx.kafka.publish(TREASURY_TOPIC, key, {
    batchId,
    programs: entries.map((entry) => ({
      ...entry,
      effectiveAt: new Date().toISOString(),
    })),
  });
  return `${record.topic}[${record.partition}]@${record.offset}`;
}

// The application derives the per-entry inbox identity from batchId + programId +
// sourceVersion (the wire contract carries no per-entry externalEventId).
export function derivedExternalEventId(entry: {
  batchId: string;
  programId: string;
  sourceVersion: number;
}): string {
  return `${entry.batchId}:${entry.programId}:${entry.sourceVersion}`;
}

export async function waitForProgram(
  ctx: ValidationContext,
  session: Session,
  programId: string,
  predicate: (program: unknown) => boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<unknown> {
  return waitFor(
    description,
    async () => {
      const response = await ctx.api.get(
        `/programs/${programId}`,
        session.accessToken,
      );
      return response.status === 200 && predicate(response.body)
        ? response.body
        : null;
    },
    { timeoutMs, intervalMs: 500 },
  );
}

// Proves every earlier message on the (single-partition, same-key) treasury topic has
// been consumed: publishes a snapshot for a dedicated sentinel Program behind them and
// waits until that snapshot is applied. Lets duplicate/stale scenarios assert that
// "nothing changed" only after the consumer has provably processed the message.
export class ReconciliationFlusher {
  private nextVersion: number;

  constructor(
    private readonly ctx: ValidationContext,
    private readonly session: Session,
    private readonly sentinelProgramId: string,
    private readonly runId: string,
    currentVersion: number,
  ) {
    this.nextVersion = currentVersion + 1;
  }

  async flush(key: string): Promise<void> {
    const version = this.nextVersion;
    this.nextVersion += 1;
    await publishReconciliation(
      this.ctx,
      `${this.runId}-sentinel-${version}`,
      [
        {
          programId: this.sentinelProgramId,
          sourceVersion: version,
          totalCapacityUsd: `${version}.0000`,
        },
      ],
      key,
    );
    await waitForProgram(
      this.ctx,
      this.session,
      this.sentinelProgramId,
      (program) => (numberAt(program, 'treasuryVersion') ?? -1) >= version,
      `sentinel program to reach treasuryVersion ${version}`,
      60_000,
    );
  }
}

export function track(ctx: ValidationContext, program: TrackedProgram): void {
  ctx.trackedPrograms.push(program);
}
