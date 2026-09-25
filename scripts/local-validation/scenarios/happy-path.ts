import { sqlLiteral } from '../support/database-probe';
import { decimalEquals } from '../support/decimal';
import {
  Session,
  assertNoSensitiveFields,
  capacityOf,
  createInvoice,
  createProgram,
  derivedExternalEventId,
  expectCapacity,
  expectSingleOutboxEventPublished,
  expectStatus,
  expectStatusField,
  getOk,
  newPassword,
  publishReconciliation,
  release,
  requireString,
  reserve,
  sameMonetarySnapshot,
  track,
  waitForProgram,
} from '../support/domain-actions';
import { numberAt, stringAt } from '../support/json-path';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import { ValidationContext } from '../support/validation-context';

interface HappyPathState {
  session?: Session;
  password?: string;
  email?: string;
  programId?: string;
  invoiceId?: string;
  reservationId?: string;
  reservation?: unknown;
  releaseId?: string;
  release?: unknown;
}

const INITIAL_CAPACITY = '1000';
const INVOICE_AMOUNT = '300';
const RECONCILED_CAPACITY = '1200.0000';

// One complete, uniquely namespaced business flow. Every step is its own reported
// scenario; a failing step marks the remaining steps of this iteration SKIPPED.
export async function runHappyPathIteration(
  ctx: ValidationContext,
  runId: string,
): Promise<boolean> {
  const state: HappyPathState = {};
  const key = (id: string): string => scenarioKey(runId, id);

  await ctx.runner.run(
    {
      id: 'register',
      name: 'Register user',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected:
        'HTTP 201; user.id returned; no password/passwordHash in response',
    },
    async (sc: ScenarioContext) => {
      state.email = `validation+${runId}@example.com`;
      state.password = newPassword(ctx);
      const response = await ctx.api.post('/users/register', {
        email: state.email,
        password: state.password,
      });
      expectStatus(ctx, sc, response, 201, 'register');
      const userId = requireString(sc, response.body, 'user.id', 'register');
      assertNoSensitiveFields(sc, response.body, state.password, 'register');
      const tokensIssued =
        stringAt(response.body, 'access_token') !== undefined &&
        stringAt(response.body, 'refresh_token') !== undefined;
      for (const field of ['access_token', 'refresh_token']) {
        const token = stringAt(response.body, field);
        if (token) {
          ctx.redactor.register(token);
        }
      }
      sc.resource('userId', userId);
      sc.resource('email', state.email);
      sc.observe(
        `HTTP 201, userId=${userId}, tokens issued on registration: ${tokensIssued}`,
      );
      sc.observe('no password/passwordHash field in response');
      state.session = {
        userId,
        email: state.email,
        accessToken: '',
        refreshToken: '',
        password: state.password,
      };
    },
  );

  await ctx.runner.run(
    {
      id: 'login',
      name: 'Login',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected:
        'HTTP 200 with access_token and refresh_token; access token accepted by GET /auth/me',
      dependsOn: [key('register')],
    },
    async (sc: ScenarioContext) => {
      const session = state.session;
      sc.check(session !== undefined, 'no session');
      const response = await ctx.api.post('/users/login', {
        email: session.email,
        password: session.password,
      });
      expectStatus(ctx, sc, response, 200, 'login');
      session.accessToken = requireString(
        sc,
        response.body,
        'access_token',
        'login',
      );
      session.refreshToken = requireString(
        sc,
        response.body,
        'refresh_token',
        'login',
      );
      ctx.redactor.register(session.accessToken);
      ctx.redactor.register(session.refreshToken);
      assertNoSensitiveFields(sc, response.body, session.password, 'login');

      const me = await ctx.api.get('/auth/me', session.accessToken);
      expectStatus(ctx, sc, me, 200, 'GET /auth/me');
      sc.check(
        stringAt(me.body, 'id') === session.userId,
        'GET /auth/me returned a different user id',
      );
      sc.observe(
        'login HTTP 200; access+refresh tokens captured in memory only',
      );
      sc.observe(
        `GET /auth/me -> 200, id matches, authMethod=${stringAt(me.body, 'authMethod')}`,
      );
    },
  );

  await ctx.runner.run(
    {
      id: 'create-program',
      name: 'Create Program (1000 USD)',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected: 'HTTP 201; GET shows total=1000 reserved=0 available=1000',
      dependsOn: [key('login')],
    },
    async (sc: ScenarioContext) => {
      const session = state.session;
      sc.check(session !== undefined, 'no session');
      state.programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}`,
        INITIAL_CAPACITY,
      );
      sc.resource('programId', state.programId);
      await expectCapacity(
        ctx,
        sc,
        session,
        state.programId,
        {
          total: INITIAL_CAPACITY,
          reserved: '0',
          available: INITIAL_CAPACITY,
        },
        'after create',
      );
    },
  );

  await ctx.runner.run(
    {
      id: 'create-invoice',
      name: 'Create and read Invoice (300 USD)',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected:
        'HTTP 201; status OPEN; original=300 USD; converted=300 USD; rate=1 (no FX call for USD)',
      dependsOn: [key('create-program')],
    },
    async (sc: ScenarioContext) => {
      const session = state.session;
      sc.check(session !== undefined, 'no session');
      const externalReference = `VALIDATION-${runId}-INV-01`;
      const created = await createInvoice(
        ctx,
        sc,
        session,
        externalReference,
        INVOICE_AMOUNT,
      );
      state.invoiceId = requireString(sc, created.body, 'id', 'invoice');
      sc.resource('invoiceId', state.invoiceId);
      sc.resource('invoiceExternalReference', externalReference);

      const invoice = await getOk(
        ctx,
        sc,
        session,
        `/invoices/${state.invoiceId}`,
      );
      const observed = {
        status: stringAt(invoice, 'status'),
        original: `${stringAt(invoice, 'originalMoney.amount')} ${stringAt(invoice, 'originalMoney.currency')}`,
        converted: `${stringAt(invoice, 'convertedMoneyUsd.amount')} ${stringAt(invoice, 'convertedMoneyUsd.currency')}`,
        rate: stringAt(invoice, 'conversion.rate'),
        source: stringAt(invoice, 'conversion.source'),
      };
      sc.observe(`invoice: ${JSON.stringify(observed)}`);
      sc.check(
        observed.status === 'OPEN',
        `expected OPEN, got ${observed.status}`,
      );
      sc.check(
        decimalEquals(
          stringAt(invoice, 'originalMoney.amount'),
          INVOICE_AMOUNT,
        ) && stringAt(invoice, 'originalMoney.currency') === 'USD',
        'original money mismatch',
      );
      sc.check(
        decimalEquals(
          stringAt(invoice, 'convertedMoneyUsd.amount'),
          INVOICE_AMOUNT,
        ) && stringAt(invoice, 'convertedMoneyUsd.currency') === 'USD',
        'converted USD money mismatch',
      );
      sc.check(
        decimalEquals(observed.rate, '1'),
        `USD->USD rate should be 1, got ${observed.rate}`,
      );
    },
  );

  await ctx.runner.run(
    {
      id: 'reserve',
      name: 'Reserve Invoice against Program',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected:
        'HTTP 201 ACTIVE; Invoice RESERVED; Program reserved=300 available=700; reservation.created outbox row published',
      dependsOn: [key('create-invoice')],
    },
    async (sc: ScenarioContext) => {
      const session = state.session;
      const { programId, invoiceId } = state;
      sc.check(
        session !== undefined &&
          programId !== undefined &&
          invoiceId !== undefined,
        'missing state',
      );
      const response = await reserve(ctx, session, programId, invoiceId);
      expectStatus(ctx, sc, response, 201, 'reserve');
      state.reservationId = requireString(sc, response.body, 'id', 'reserve');
      sc.resource('reservationId', state.reservationId);
      sc.check(
        stringAt(response.body, 'status') === 'ACTIVE',
        'reservation not ACTIVE',
      );

      state.reservation = await expectStatusField(
        ctx,
        sc,
        session,
        `/reservations/${state.reservationId}`,
        'ACTIVE',
      );
      await expectStatusField(
        ctx,
        sc,
        session,
        `/invoices/${invoiceId}`,
        'RESERVED',
      );
      sc.observe('Reservation ACTIVE, Invoice RESERVED');
      await expectCapacity(
        ctx,
        sc,
        session,
        programId,
        {
          total: INITIAL_CAPACITY,
          reserved: INVOICE_AMOUNT,
          available: '700',
        },
        'after reserve',
      );
      const outbox = await expectSingleOutboxEventPublished(
        ctx,
        sc,
        'reservation.created',
        'reservationId',
        state.reservationId,
      );
      sc.resource('reservationEventId', outbox.eventId);
    },
  );

  await ctx.runner.run(
    {
      id: 'release',
      name: 'Release Reservation',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected:
        'HTTP 201; Reservation RELEASED; Invoice REPAID; capacity restored to 1000; Release money/FX == Reservation snapshot; one release row',
      dependsOn: [key('reserve')],
    },
    async (sc: ScenarioContext) => {
      const session = state.session;
      const { programId, invoiceId, reservationId } = state;
      sc.check(
        session !== undefined &&
          programId !== undefined &&
          invoiceId !== undefined &&
          reservationId !== undefined,
        'missing state',
      );
      const response = await release(ctx, session, reservationId);
      expectStatus(ctx, sc, response, 201, 'release');
      state.releaseId = requireString(sc, response.body, 'id', 'release');
      sc.resource('releaseId', state.releaseId);

      await expectStatusField(
        ctx,
        sc,
        session,
        `/reservations/${reservationId}`,
        'RELEASED',
      );
      await expectStatusField(
        ctx,
        sc,
        session,
        `/invoices/${invoiceId}`,
        'REPAID',
      );
      sc.observe('Reservation RELEASED, Invoice REPAID');
      await expectCapacity(
        ctx,
        sc,
        session,
        programId,
        {
          total: INITIAL_CAPACITY,
          reserved: '0',
          available: INITIAL_CAPACITY,
        },
        'after release',
      );

      state.release = await getOk(
        ctx,
        sc,
        session,
        `/releases/${state.releaseId}`,
      );
      sc.check(
        sameMonetarySnapshot(state.release, state.reservation),
        'Release monetary/FX snapshot differs from Reservation snapshot',
      );
      sc.observe(
        `release money=${stringAt(state.release, 'originalMoney.amount')} ${stringAt(state.release, 'originalMoney.currency')} usd=${stringAt(state.release, 'convertedMoneyUsd.amount')} rate=${stringAt(state.release, 'conversion.rate')} == reservation snapshot`,
      );
      const rows = await ctx.db.count(
        `SELECT 1 FROM releases WHERE reservation_id = ${sqlLiteral(reservationId)}`,
      );
      sc.check(rows === 1, `expected 1 release row, found ${rows}`);
      sc.observe('releases table: exactly 1 row for this reservation');
      const outbox = await expectSingleOutboxEventPublished(
        ctx,
        sc,
        'release.created',
        'releaseId',
        state.releaseId,
      );
      sc.resource('releaseEventId', outbox.eventId);
    },
  );

  await ctx.runner.run(
    {
      id: 'reconcile',
      name: 'Treasury reconciliation via Kafka',
      category: 'happy-path',
      runId,
      mandatory: true,
      expected: `snapshot with sourceVersion=current+1 applied: total=1200, treasuryVersion updated; Reservation RELEASED, Invoice REPAID, Release unchanged`,
      dependsOn: [key('release')],
    },
    async (sc: ScenarioContext) => {
      const session = state.session;
      const { programId, invoiceId, reservationId, releaseId } = state;
      sc.check(
        session !== undefined &&
          programId !== undefined &&
          invoiceId !== undefined &&
          reservationId !== undefined &&
          releaseId !== undefined,
        'missing state',
      );
      const before = capacityOf(
        await getOk(ctx, sc, session, `/programs/${programId}`),
      );
      const currentVersion = before.treasuryVersion ?? 0;
      const sourceVersion = currentVersion + 1;
      const batchId = `${runId}-batch-01`;
      const externalEventId = derivedExternalEventId({
        batchId,
        programId,
        sourceVersion,
      });
      sc.resource('batchId', batchId);
      sc.resource('externalEventId', externalEventId);

      const location = await publishReconciliation(
        ctx,
        batchId,
        [{ programId, sourceVersion, totalCapacityUsd: RECONCILED_CAPACITY }],
        programId,
      );
      sc.observe(
        `published ${location}: sourceVersion ${currentVersion} -> ${sourceVersion}, total 1000 -> 1200`,
      );

      const program = await waitForProgram(
        ctx,
        session,
        programId,
        (body) => numberAt(body, 'treasuryVersion') === sourceVersion,
        'reconciliation to be applied',
      );
      const after = capacityOf(program);
      sc.observe(
        `after: total=${after.total} reserved=${after.reserved} available=${after.available} treasuryVersion=${after.treasuryVersion}`,
      );
      sc.check(
        decimalEquals(after.total, '1200'),
        `expected total 1200, got ${after.total}`,
      );
      sc.check(
        decimalEquals(after.reserved, '0') &&
          decimalEquals(after.available, '1200'),
        'availability not recalculated from active reservations',
      );

      await expectStatusField(
        ctx,
        sc,
        session,
        `/reservations/${reservationId}`,
        'RELEASED',
      );
      await expectStatusField(
        ctx,
        sc,
        session,
        `/invoices/${invoiceId}`,
        'REPAID',
      );
      const releaseAfter = await getOk(
        ctx,
        sc,
        session,
        `/releases/${releaseId}`,
      );
      sc.check(
        JSON.stringify(releaseAfter) === JSON.stringify(state.release),
        'Release changed after reconciliation',
      );
      sc.observe(
        'Reservation RELEASED, Invoice REPAID, Release byte-identical after reconciliation',
      );

      const rows = await ctx.db.query(
        `SELECT status FROM reconciliations WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      sc.check(
        rows.length === 1 && rows[0]?.status === 'APPLIED',
        `expected one APPLIED reconciliation row, got ${JSON.stringify(rows)}`,
      );
      const inbox = await ctx.db.count(
        `SELECT 1 FROM reconciliation_events WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      sc.check(inbox === 1, `expected 1 inbox row, found ${inbox}`);
      sc.observe(
        'reconciliations: 1 APPLIED row; reconciliation_events inbox: 1 row',
      );
      const reconciliationId = await ctx.db.scalar(
        `SELECT id FROM reconciliations WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      sc.resource('reconciliationId', String(reconciliationId));
      await expectSingleOutboxEventPublished(
        ctx,
        sc,
        'reconciliation.applied',
        'externalEventId',
        externalEventId,
      );

      track(ctx, {
        runId,
        programId,
        expectedTotalUsd: '1200',
        expectedReservedUsd: '0',
        expectedTreasuryVersion: sourceVersion,
      });
    },
  );

  return ctx.runner.statusOf(key('reconcile')) === 'PASS';
}
