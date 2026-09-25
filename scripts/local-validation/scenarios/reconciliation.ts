import { sqlLiteral } from '../support/database-probe';
import { decimalEquals } from '../support/decimal';
import {
  ReconciliationFlusher,
  Session,
  capacityOf,
  createProgram,
  derivedExternalEventId,
  getOk,
  publishReconciliation,
  registerAndLogin,
  track,
  waitForProgram,
} from '../support/domain-actions';
import { numberAt, stringAt } from '../support/json-path';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import { ValidationContext, runIdFor } from '../support/validation-context';

async function reconciliationRows(
  ctx: ValidationContext,
  programId: string,
): Promise<
  { externalEventId: string; sourceVersion: number; status: string }[]
> {
  const rows = await ctx.db.query(
    `SELECT external_event_id, source_version, status FROM reconciliations
      WHERE program_id = ${sqlLiteral(programId)} ORDER BY created_at`,
  );
  return rows.map((row) => ({
    externalEventId: String(row.external_event_id),
    sourceVersion: Number(row.source_version),
    status: String(row.status),
  }));
}

async function appliedOutboxCount(
  ctx: ValidationContext,
  programId: string,
): Promise<number> {
  return ctx.db.count(
    `SELECT 1 FROM outbox_events WHERE event_type = 'reconciliation.applied'
        AND payload->'payload'->>'programId' = ${sqlLiteral(programId)}`,
  );
}

async function applyAndWait(
  ctx: ValidationContext,
  sc: ScenarioContext,
  session: Session,
  programId: string,
  batchId: string,
  sourceVersion: number,
  total: string,
): Promise<unknown> {
  const location = await publishReconciliation(
    ctx,
    batchId,
    [{ programId, sourceVersion, totalCapacityUsd: total }],
    programId,
  );
  sc.observe(
    `published batch=${batchId} v${sourceVersion} total=${total} -> ${location}`,
  );
  return waitForProgram(
    ctx,
    session,
    programId,
    (body) => numberAt(body, 'treasuryVersion') === sourceVersion,
    `treasuryVersion ${sourceVersion}`,
  );
}

export async function runReconciliationScenarios(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'recon');
  let session: Session | undefined;
  let flusher: ReconciliationFlusher | undefined;

  await ctx.runner.run(
    {
      id: 'reconciliation-fixture',
      name: 'Reconciliation fixture (user + sentinel Program)',
      category: 'reconciliation',
      runId,
      mandatory: true,
      expected:
        'user and sentinel Program created; sentinel snapshot consumed (proves consumer is live)',
    },
    async (sc: ScenarioContext) => {
      session = await registerAndLogin(ctx, sc, runId);
      const sentinelId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-sentinel`,
        '1',
      );
      sc.resource('sentinelProgramId', sentinelId);
      const version =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${sentinelId}`),
          'treasuryVersion',
        ) ?? 0;
      flusher = new ReconciliationFlusher(
        ctx,
        session,
        sentinelId,
        runId,
        version,
      );
      await flusher.flush(sentinelId);
      sc.observe('sentinel snapshot applied - treasury consumer is live');
    },
  );
  const dependsOn = [scenarioKey(runId, 'reconciliation-fixture')];

  await ctx.runner.run(
    {
      id: 'reconciliation-duplicate',
      name: 'Duplicate reconciliation event is idempotent',
      category: 'reconciliation',
      runId,
      mandatory: true,
      expected:
        'same batchId/programId/sourceVersion published twice -> applied once: 1 reconciliation row, 1 inbox row, 1 reconciliation.applied outbox event; Program unchanged by the duplicate',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(
        session !== undefined && flusher !== undefined,
        'fixture missing',
      );
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-duplicate`,
        '1000',
      );
      sc.resource('programId', programId);
      const v0 =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programId}`),
          'treasuryVersion',
        ) ?? 0;
      const batchId = `${runId}-dup-batch-01`;
      const sourceVersion = v0 + 1;
      const externalEventId = derivedExternalEventId({
        batchId,
        programId,
        sourceVersion,
      });
      sc.resource('batchId', batchId);
      sc.resource('externalEventId', externalEventId);

      const applied = await applyAndWait(
        ctx,
        sc,
        session,
        programId,
        batchId,
        sourceVersion,
        '1500.0000',
      );
      const updatedAtAfterFirst = stringAt(applied, 'updatedAt');

      await publishReconciliation(
        ctx,
        batchId,
        [{ programId, sourceVersion, totalCapacityUsd: '1500.0000' }],
        programId,
      );
      sc.observe(
        'republished identical logical event (same batchId, programId, sourceVersion, total)',
      );
      await flusher.flush(programId);
      sc.observe(
        'sentinel behind the duplicate consumed -> duplicate provably processed',
      );

      const program = await getOk(ctx, sc, session, `/programs/${programId}`);
      const capacity = capacityOf(program);
      sc.observe(
        `program: total=${capacity.total} treasuryVersion=${capacity.treasuryVersion} updatedAt unchanged=${stringAt(program, 'updatedAt') === updatedAtAfterFirst}`,
      );
      sc.check(
        decimalEquals(capacity.total, '1500') &&
          capacity.treasuryVersion === sourceVersion,
        'program state changed/rolled back after duplicate',
      );
      sc.check(
        stringAt(program, 'updatedAt') === updatedAtAfterFirst,
        'duplicate event mutated the Program (updatedAt changed)',
      );

      const rows = await ctx.db.count(
        `SELECT 1 FROM reconciliations WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      const inbox = await ctx.db.count(
        `SELECT 1 FROM reconciliation_events WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      const outbox = await appliedOutboxCount(ctx, programId);
      sc.observe(
        `reconciliations=${rows} inbox=${inbox} reconciliation.applied outbox=${outbox}`,
      );
      sc.check(
        rows === 1 && inbox === 1 && outbox === 1,
        'duplicate produced additional business effects',
      );
      track(ctx, {
        runId,
        programId,
        expectedTotalUsd: '1500',
        expectedReservedUsd: '0',
        expectedTreasuryVersion: sourceVersion,
      });
    },
  );

  await ctx.runner.run(
    {
      id: 'reconciliation-stale',
      name: 'Stale reconciliation is ignored',
      category: 'reconciliation',
      runId,
      mandatory: true,
      expected:
        'after applying version N: sourceVersion N-1 (different capacity) and a different-batch sourceVersion N are IGNORED_STALE; Program stays at version N and its total',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(
        session !== undefined && flusher !== undefined,
        'fixture missing',
      );
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-stale`,
        '1000',
      );
      sc.resource('programId', programId);
      const v0 =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programId}`),
          'treasuryVersion',
        ) ?? 0;
      const n = v0 + 2;
      await applyAndWait(
        ctx,
        sc,
        session,
        programId,
        `${runId}-stale-batch-01`,
        n,
        '1800.0000',
      );

      await publishReconciliation(
        ctx,
        `${runId}-stale-batch-02`,
        [{ programId, sourceVersion: n - 1, totalCapacityUsd: '999.0000' }],
        programId,
      );
      sc.observe(`published stale v${n - 1} total=999`);
      await publishReconciliation(
        ctx,
        `${runId}-stale-batch-03`,
        [{ programId, sourceVersion: n, totalCapacityUsd: '777.0000' }],
        programId,
      );
      sc.observe(`published equal-version v${n} (new batch) total=777`);
      await flusher.flush(programId);

      const capacity = capacityOf(
        await getOk(ctx, sc, session, `/programs/${programId}`),
      );
      sc.observe(
        `program after stale events: total=${capacity.total} treasuryVersion=${capacity.treasuryVersion}`,
      );
      sc.check(
        decimalEquals(capacity.total, '1800') && capacity.treasuryVersion === n,
        'stale reconciliation changed Program',
      );

      const rows = await reconciliationRows(ctx, programId);
      sc.observe(
        `reconciliation audit: ${rows.map((row) => `v${row.sourceVersion}=${row.status}`).join(', ')}`,
      );
      sc.check(
        rows.filter((row) => row.status === 'IGNORED_STALE').length === 2 &&
          rows.filter((row) => row.status === 'APPLIED').length === 1,
        'expected 1 APPLIED and 2 IGNORED_STALE audit rows',
      );
      sc.check(
        (await appliedOutboxCount(ctx, programId)) === 1,
        'stale events emitted reconciliation.applied',
      );
      track(ctx, {
        runId,
        programId,
        expectedTotalUsd: '1800',
        expectedReservedUsd: '0',
        expectedTreasuryVersion: n,
      });
    },
  );

  await ctx.runner.run(
    {
      id: 'reconciliation-gap',
      name: 'Newer snapshot subsumes version gap',
      category: 'reconciliation',
      runId,
      mandatory: true,
      expected:
        'at version N, snapshot N+3 applies (treasuryVersion=N+3); late N+1 and N+2 are IGNORED_STALE with no rollback',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(
        session !== undefined && flusher !== undefined,
        'fixture missing',
      );
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-gap`,
        '1000',
      );
      sc.resource('programId', programId);
      const v0 =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programId}`),
          'treasuryVersion',
        ) ?? 0;
      const n = v0 + 1;
      await applyAndWait(
        ctx,
        sc,
        session,
        programId,
        `${runId}-gap-batch-01`,
        n,
        '1100.0000',
      );
      const applied = await applyAndWait(
        ctx,
        sc,
        session,
        programId,
        `${runId}-gap-batch-02`,
        n + 3,
        '1400.0000',
      );
      sc.check(
        decimalEquals(capacityOf(applied).total, '1400'),
        'N+3 snapshot not applied',
      );
      sc.observe(`N=${n} -> N+3=${n + 3} applied, total=1400`);

      await publishReconciliation(
        ctx,
        `${runId}-gap-batch-03`,
        [{ programId, sourceVersion: n + 1, totalCapacityUsd: '1200.0000' }],
        programId,
      );
      await publishReconciliation(
        ctx,
        `${runId}-gap-batch-04`,
        [{ programId, sourceVersion: n + 2, totalCapacityUsd: '1300.0000' }],
        programId,
      );
      sc.observe(`published late v${n + 1} and v${n + 2}`);
      await flusher.flush(programId);

      const capacity = capacityOf(
        await getOk(ctx, sc, session, `/programs/${programId}`),
      );
      sc.observe(
        `program after late events: total=${capacity.total} treasuryVersion=${capacity.treasuryVersion}`,
      );
      sc.check(
        decimalEquals(capacity.total, '1400') &&
          capacity.treasuryVersion === n + 3,
        'late events rolled the Program back',
      );
      const rows = await reconciliationRows(ctx, programId);
      sc.observe(
        `reconciliation audit: ${rows.map((row) => `v${row.sourceVersion}=${row.status}`).join(', ')}`,
      );
      const late = rows.filter(
        (row) => row.sourceVersion === n + 1 || row.sourceVersion === n + 2,
      );
      sc.check(
        late.length === 2 &&
          late.every((row) => row.status === 'IGNORED_STALE'),
        'late versions not recorded as IGNORED_STALE',
      );
      track(ctx, {
        runId,
        programId,
        expectedTotalUsd: '1400',
        expectedReservedUsd: '0',
        expectedTreasuryVersion: n + 3,
      });
    },
  );

  await ctx.runner.run(
    {
      id: 'reconciliation-bulk',
      name: 'Bulk message: independent per-Program entries',
      category: 'reconciliation',
      runId,
      mandatory: false,
      expected:
        'one bulk message with a fresh entry for Program A and a stale entry for Program B -> A APPLIED, B IGNORED_STALE, B unchanged',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(
        session !== undefined && flusher !== undefined,
        'fixture missing',
      );
      const programA = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-bulk-a`,
        '500',
      );
      const programB = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-bulk-b`,
        '500',
      );
      sc.resource('programIdA', programA);
      sc.resource('programIdB', programB);
      const vA =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programA}`),
          'treasuryVersion',
        ) ?? 0;
      const vB =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programB}`),
          'treasuryVersion',
        ) ?? 0;
      await applyAndWait(
        ctx,
        sc,
        session,
        programB,
        `${runId}-bulk-batch-00`,
        vB + 1,
        '650.0000',
      );

      const batchId = `${runId}-bulk-batch-01`;
      sc.resource('batchId', batchId);
      await publishReconciliation(
        ctx,
        batchId,
        [
          {
            programId: programA,
            sourceVersion: vA + 1,
            totalCapacityUsd: '900.0000',
          },
          {
            programId: programB,
            sourceVersion: vB + 1,
            totalCapacityUsd: '1.0000',
          },
        ],
        programA,
      );
      await flusher.flush(programA);

      const a = capacityOf(
        await getOk(ctx, sc, session, `/programs/${programA}`),
      );
      const b = capacityOf(
        await getOk(ctx, sc, session, `/programs/${programB}`),
      );
      sc.observe(
        `A: total=${a.total} v=${a.treasuryVersion}; B: total=${b.total} v=${b.treasuryVersion}`,
      );
      sc.check(
        decimalEquals(a.total, '900') && a.treasuryVersion === vA + 1,
        'bulk entry A not applied',
      );
      sc.check(
        decimalEquals(b.total, '650') && b.treasuryVersion === vB + 1,
        'stale bulk entry B changed Program B',
      );
      const statusB = (await reconciliationRows(ctx, programB)).find((row) =>
        row.externalEventId.startsWith(batchId),
      );
      sc.check(
        statusB?.status === 'IGNORED_STALE',
        'bulk entry B not recorded IGNORED_STALE',
      );
    },
  );
}
