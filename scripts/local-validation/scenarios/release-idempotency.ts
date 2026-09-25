import { ApiResponse } from '../support/api-client';
import { sqlLiteral } from '../support/database-probe';
import {
  Session,
  createInvoice,
  createProgram,
  expectCapacity,
  expectSingleOutboxEventPublished,
  expectStatus,
  expectStatusField,
  registerAndLogin,
  release,
  requireString,
  reserve,
} from '../support/domain-actions';
import { stringAt } from '../support/json-path';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import { ValidationContext, runIdFor } from '../support/validation-context';

interface ActiveReservation {
  programId: string;
  invoiceId: string;
  reservationId: string;
}

async function prepareActiveReservation(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  runId: string,
  tag: string,
): Promise<ActiveReservation> {
  const programId = await createProgram(
    ctx,
    sc,
    session,
    `Validation Program ${runId}-${tag}`,
    '1000',
  );
  const invoiceId = requireString(
    sc,
    (
      await createInvoice(
        ctx,
        sc,
        session,
        `VALIDATION-${runId}-${tag.toUpperCase()}`,
        '70',
      )
    ).body,
    'id',
    'invoice',
  );
  const reserved = await reserve(ctx, session, programId, invoiceId);
  expectStatus(ctx, sc, reserved, 201, 'reserve');
  const reservationId = requireString(sc, reserved.body, 'id', 'reservation');
  sc.resource('programId', programId);
  sc.resource('invoiceId', invoiceId);
  sc.resource('reservationId', reservationId);
  await expectCapacity(
    ctx,
    sc,
    session,
    programId,
    { total: '1000', reserved: '70', available: '930' },
    'before release',
  );
  return { programId, invoiceId, reservationId };
}

async function expectSingleReleaseEffect(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  target: ActiveReservation,
  responses: ApiResponse[],
): Promise<void> {
  sc.observe(
    `release statuses: ${responses.map((response) => response.status).join(' | ')}`,
  );
  sc.check(
    responses.every(
      (response) => response.status < 500 && response.status !== 0,
    ),
    'a release request failed with a server/network error',
  );
  const successes = responses.filter(
    (response) => response.status === 201 || response.status === 200,
  );
  sc.check(successes.length >= 1, 'no release request succeeded');
  const ids = new Set(
    successes.map((response) => stringAt(response.body, 'id')),
  );
  sc.check(
    ids.size === 1,
    `successful responses identify ${ids.size} different releases`,
  );
  const [releaseId] = [...ids];
  sc.resource('releaseId', releaseId ?? '?');
  sc.observe(
    `all successful responses identify the same Release (${successes.length}/${responses.length} succeeded)`,
  );

  const rows = await ctx.db.count(
    `SELECT 1 FROM releases WHERE reservation_id = ${sqlLiteral(target.reservationId)}`,
  );
  sc.check(rows === 1, `expected 1 release row, found ${rows}`);
  sc.observe('releases table: exactly 1 row');
  await expectStatusField(
    ctx,
    sc,
    session,
    `/reservations/${target.reservationId}`,
    'RELEASED',
  );
  await expectStatusField(
    ctx,
    sc,
    session,
    `/invoices/${target.invoiceId}`,
    'REPAID',
  );
  await expectCapacity(
    ctx,
    sc,
    session,
    target.programId,
    { total: '1000', reserved: '0', available: '1000' },
    'after releases',
  );
  if (releaseId) {
    await expectSingleOutboxEventPublished(
      ctx,
      sc,
      'release.created',
      'reservationId',
      target.reservationId,
    );
  }
}

export async function runReleaseIdempotencyScenarios(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'release');
  let session: Session | undefined;

  await ctx.runner.run(
    {
      id: 'release-session',
      name: 'Release fixture user',
      category: 'release-idempotency',
      runId,
      mandatory: true,
      expected: 'user registered and logged in',
    },
    async (sc: ScenarioContext) => {
      session = await registerAndLogin(ctx, sc, runId);
    },
  );
  const dependsOn = [scenarioKey(runId, 'release-session')];

  await ctx.runner.run(
    {
      id: 'duplicate-release-sequential',
      name: 'Duplicate Release (sequential)',
      category: 'release-idempotency',
      runId,
      mandatory: true,
      expected:
        'two sequential releases -> one logical Release (same id), one release row, one release.created event; RELEASED/REPAID; capacity restored once',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(session !== undefined, 'no session');
      const target = await prepareActiveReservation(
        ctx,
        sc,
        session,
        runId,
        'seq-release',
      );
      const first = await release(ctx, session, target.reservationId);
      const second = await release(ctx, session, target.reservationId);
      await expectSingleReleaseEffect(ctx, sc, session, target, [
        first,
        second,
      ]);
    },
  );

  await ctx.runner.run(
    {
      id: 'duplicate-release-concurrent',
      name: 'Duplicate Release (concurrent)',
      category: 'release-idempotency',
      runId,
      mandatory: true,
      expected:
        'two concurrent releases -> one Release business effect; RELEASED/REPAID; capacity restored once; no 5xx',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(session !== undefined, 'no session');
      const s = session;
      const target = await prepareActiveReservation(
        ctx,
        sc,
        s,
        runId,
        'concurrent-release',
      );
      const responses = await Promise.all([
        release(ctx, s, target.reservationId),
        release(ctx, s, target.reservationId),
      ]);
      await expectSingleReleaseEffect(ctx, sc, s, target, responses);
    },
  );
}
