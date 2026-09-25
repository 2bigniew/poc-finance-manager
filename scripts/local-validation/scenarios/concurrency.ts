import { ApiResponse } from '../support/api-client';
import { sqlLiteral } from '../support/database-probe';
import {
  Session,
  createInvoice,
  createProgram,
  expectCapacity,
  expectStatusField,
  registerAndLogin,
  requireString,
  reserve,
} from '../support/domain-actions';
import { stringAt } from '../support/json-path';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import { ValidationContext, runIdFor } from '../support/validation-context';

const OVERSUBSCRIPTION_ROUNDS = 3;

function describeResponses(responses: ApiResponse[]): string {
  return responses
    .map((response) => {
      const message = stringAt(response.body, 'message');
      return `${response.status}${message ? ` (${message})` : ''}`;
    })
    .join(' | ');
}

// Both requests are started before either is awaited; the reported overlap proves they
// were in flight at the same time rather than serialized by the client.
async function concurrently(
  sc: ScenarioContext,
  requests: (() => Promise<ApiResponse>)[],
): Promise<ApiResponse[]> {
  const responses = await Promise.all(requests.map((request) => request()));
  const latestStart = Math.max(
    ...responses.map((response) => response.startedAt),
  );
  const earliestFinish = Math.min(
    ...responses.map((response) => response.finishedAt),
  );
  sc.observe(
    `requests in flight concurrently: start spread=${latestStart - Math.min(...responses.map((r) => r.startedAt))}ms, overlap=${earliestFinish - latestStart}ms`,
  );
  return responses;
}

async function activeReservationCount(
  ctx: ValidationContext,
  column: 'program_id' | 'invoice_id',
  id: string,
): Promise<number> {
  return ctx.db.count(
    `SELECT 1 FROM reservations WHERE ${column} = ${sqlLiteral(id)} AND status = 'ACTIVE'`,
  );
}

export async function runConcurrencyScenarios(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'concurrency');
  let session: Session | undefined;

  await ctx.runner.run(
    {
      id: 'concurrency-session',
      name: 'Concurrency fixture user',
      category: 'concurrency',
      runId,
      mandatory: true,
      expected: 'user registered and logged in',
    },
    async (sc: ScenarioContext) => {
      session = await registerAndLogin(ctx, sc, runId);
    },
  );
  const dependsOn = [scenarioKey(runId, 'concurrency-session')];

  await ctx.runner.run(
    {
      id: 'concurrent-oversubscription',
      name: `Concurrent oversubscription blocked (${OVERSUBSCRIPTION_ROUNDS} rounds)`,
      category: 'concurrency',
      runId,
      mandatory: true,
      expected:
        'capacity 100; two concurrent 80 USD reservations -> exactly one 201 and one 409 insufficient capacity; reserved=80 available=20',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(session !== undefined, 'no session');
      const s = session;
      for (let round = 1; round <= OVERSUBSCRIPTION_ROUNDS; round += 1) {
        const tag = `R${round}`;
        const programId = await createProgram(
          ctx,
          sc,
          s,
          `Validation Program ${runId}-oversub-${tag}`,
          '100',
        );
        const invoiceA = requireString(
          sc,
          (
            await createInvoice(
              ctx,
              sc,
              s,
              `VALIDATION-${runId}-OVERSUB-${tag}-A`,
              '80',
            )
          ).body,
          'id',
          'invoice A',
        );
        const invoiceB = requireString(
          sc,
          (
            await createInvoice(
              ctx,
              sc,
              s,
              `VALIDATION-${runId}-OVERSUB-${tag}-B`,
              '80',
            )
          ).body,
          'id',
          'invoice B',
        );
        sc.resource(`programId${tag}`, programId);
        sc.resource(`invoiceA${tag}`, invoiceA);
        sc.resource(`invoiceB${tag}`, invoiceB);

        const responses = await concurrently(sc, [
          () => reserve(ctx, s, programId, invoiceA),
          () => reserve(ctx, s, programId, invoiceB),
        ]);
        sc.observe(`${tag} statuses: ${describeResponses(responses)}`);
        const statuses = responses.map((response) => response.status).sort();
        sc.check(
          statuses[0] === 201 && statuses[1] === 409,
          `${tag}: expected exactly one 201 and one 409, got ${statuses.join(',')}`,
        );
        const rejected = responses.find((response) => response.status === 409);
        sc.check(
          /capacity/i.test(stringAt(rejected?.body, 'message') ?? ''),
          `${tag}: 409 is not an insufficient-capacity error`,
        );
        const winner = responses.find((response) => response.status === 201);
        sc.resource(`reservationId${tag}`, stringAt(winner?.body, 'id') ?? '?');

        await expectCapacity(
          ctx,
          sc,
          s,
          programId,
          { total: '100', reserved: '80', available: '20' },
          `${tag} final`,
        );
        const active = await activeReservationCount(
          ctx,
          'program_id',
          programId,
        );
        sc.check(
          active === 1,
          `${tag}: expected 1 ACTIVE reservation, found ${active}`,
        );
        const loserInvoice =
          stringAt(winner?.body, 'invoiceId') === invoiceA
            ? invoiceB
            : invoiceA;
        await expectStatusField(
          ctx,
          sc,
          s,
          `/invoices/${loserInvoice}`,
          'OPEN',
        );
        sc.observe(
          `${tag}: 1 ACTIVE reservation in DB; losing invoice remains OPEN`,
        );
      }
    },
  );

  await ctx.runner.run(
    {
      id: 'concurrent-valid-reservations',
      name: 'Concurrent valid reservations both succeed',
      category: 'concurrency',
      runId,
      mandatory: true,
      expected:
        'capacity 100; two concurrent 40 USD reservations -> both 201; reserved=80 available=20',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(session !== undefined, 'no session');
      const s = session;
      const programId = await createProgram(
        ctx,
        sc,
        s,
        `Validation Program ${runId}-valid`,
        '100',
      );
      const invoiceA = requireString(
        sc,
        (await createInvoice(ctx, sc, s, `VALIDATION-${runId}-VALID-A`, '40'))
          .body,
        'id',
        'A',
      );
      const invoiceB = requireString(
        sc,
        (await createInvoice(ctx, sc, s, `VALIDATION-${runId}-VALID-B`, '40'))
          .body,
        'id',
        'B',
      );
      sc.resource('programId', programId);
      sc.resource('invoiceA', invoiceA);
      sc.resource('invoiceB', invoiceB);

      const responses = await concurrently(sc, [
        () => reserve(ctx, s, programId, invoiceA),
        () => reserve(ctx, s, programId, invoiceB),
      ]);
      sc.observe(`statuses: ${describeResponses(responses)}`);
      sc.check(
        responses.every((response) => response.status === 201),
        'both reservations should succeed',
      );
      await expectCapacity(
        ctx,
        sc,
        s,
        programId,
        { total: '100', reserved: '80', available: '20' },
        'final',
      );
      const active = await activeReservationCount(ctx, 'program_id', programId);
      sc.check(active === 2, `expected 2 ACTIVE reservations, found ${active}`);
      sc.observe('2 ACTIVE reservations in DB');
    },
  );

  await ctx.runner.run(
    {
      id: 'same-invoice-duplicate',
      name: 'Concurrent duplicate reservation of same Invoice',
      category: 'concurrency',
      runId,
      mandatory: true,
      expected:
        'two concurrent reservations of one 50 USD Invoice -> one 201, one 409; one ACTIVE reservation; reserved=50; Invoice RESERVED',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(session !== undefined, 'no session');
      const s = session;
      const programId = await createProgram(
        ctx,
        sc,
        s,
        `Validation Program ${runId}-dup-invoice`,
        '1000',
      );
      const invoiceId = requireString(
        sc,
        (await createInvoice(ctx, sc, s, `VALIDATION-${runId}-DUP-INV`, '50'))
          .body,
        'id',
        'invoice',
      );
      sc.resource('programId', programId);
      sc.resource('invoiceId', invoiceId);

      const responses = await concurrently(sc, [
        () => reserve(ctx, s, programId, invoiceId),
        () => reserve(ctx, s, programId, invoiceId),
      ]);
      sc.observe(`statuses: ${describeResponses(responses)}`);
      const statuses = responses.map((response) => response.status).sort();
      sc.check(
        statuses[0] === 201 && statuses[1] === 409,
        `expected one 201 and one 409, got ${statuses.join(',')}`,
      );

      const active = await activeReservationCount(ctx, 'invoice_id', invoiceId);
      const total = await ctx.db.count(
        `SELECT 1 FROM reservations WHERE invoice_id = ${sqlLiteral(invoiceId)}`,
      );
      sc.check(
        active === 1 && total === 1,
        `expected exactly 1 reservation row (ACTIVE), found total=${total} active=${active}`,
      );
      sc.observe(`reservations for invoice: total=${total}, ACTIVE=${active}`);
      await expectStatusField(ctx, sc, s, `/invoices/${invoiceId}`, 'RESERVED');
      await expectCapacity(
        ctx,
        sc,
        s,
        programId,
        { total: '1000', reserved: '50', available: '950' },
        'final',
      );
    },
  );
}
