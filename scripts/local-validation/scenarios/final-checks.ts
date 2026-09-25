import { ScenarioContext } from '../support/scenario-runner';
import { decimalEquals } from '../support/decimal';
import { capacityOf, getOk, registerAndLogin } from '../support/domain-actions';
import { ValidationContext, runIdFor } from '../support/validation-context';
import { waitFor } from '../support/wait';
import { expectBaselinePreserved } from './infrastructure';

// Re-reads every Program tracked so far through the API and compares it with the state
// recorded when its scenario finished - proves earlier runs survive later ones.
export async function runTrackedProgramsCheck(
  ctx: ValidationContext,
  runId: string,
  id: string,
  name: string,
): Promise<void> {
  await ctx.runner.run(
    {
      id,
      name,
      category: 'persistence',
      runId,
      mandatory: true,
      expected:
        'every tracked Program from earlier runIds readable with expected total/reserved/treasuryVersion; baseline data intact',
    },
    async (sc: ScenarioContext) => {
      const session = await registerAndLogin(ctx, sc, runId, '-p');
      sc.check(ctx.trackedPrograms.length > 0, 'no tracked Programs to verify');
      for (const tracked of ctx.trackedPrograms) {
        const capacity = capacityOf(
          await getOk(ctx, sc, session, `/programs/${tracked.programId}`),
        );
        sc.check(
          decimalEquals(capacity.total, tracked.expectedTotalUsd) &&
            decimalEquals(capacity.reserved, tracked.expectedReservedUsd) &&
            capacity.treasuryVersion === tracked.expectedTreasuryVersion,
          `${tracked.runId} program ${tracked.programId}: expected total=${tracked.expectedTotalUsd} v=${tracked.expectedTreasuryVersion}, got total=${capacity.total} v=${capacity.treasuryVersion}`,
        );
      }
      sc.observe(
        `${ctx.trackedPrograms.length} tracked Programs verified from: ${[...new Set(ctx.trackedPrograms.map((t) => t.runId))].join(', ')}`,
      );
      await expectBaselinePreserved(ctx, sc);
    },
  );
}

export async function runFinalChecks(ctx: ValidationContext): Promise<void> {
  const runId = runIdFor(ctx, 'final');

  await runTrackedProgramsCheck(
    ctx,
    runId,
    'persistence-final',
    'All validation data from this run still readable',
  );

  await ctx.runner.run(
    {
      id: 'outbox-drained',
      name: 'All outbox events from this run published',
      category: 'kafka-outbox',
      runId,
      mandatory: true,
      expected:
        'every outbox row created since validation start has publishedAt set; event_id unique',
    },
    async (sc: ScenarioContext) => {
      const since = ctx.startedAt.toISOString();
      const pending = await waitFor(
        'outbox rows of this run to drain',
        async () => {
          const unpublished = await ctx.db.count(
            `SELECT 1 FROM outbox_events WHERE created_at >= '${since}' AND published_at IS NULL`,
          );
          return unpublished === 0 ? unpublished : null;
        },
        { timeoutMs: 60_000, intervalMs: 1_000 },
      );
      const total = await ctx.db.count(
        `SELECT 1 FROM outbox_events WHERE created_at >= '${since}'`,
      );
      const byType = await ctx.db.query(
        `SELECT event_type, count(*)::int AS n, max(attempts) AS max_attempts FROM outbox_events WHERE created_at >= '${since}' GROUP BY event_type ORDER BY event_type`,
      );
      const duplicateIds = await ctx.db.count(
        `SELECT event_id FROM outbox_events GROUP BY event_id HAVING count(*) > 1`,
      );
      sc.observe(
        `outbox rows this run=${total}, unpublished=${pending}; by type: ${JSON.stringify(byType)}`,
      );
      sc.check(
        duplicateIds === 0,
        `${duplicateIds} duplicated event_id values in outbox`,
      );
      const unpublishedAll = await ctx.db.count(
        'SELECT 1 FROM outbox_events WHERE published_at IS NULL',
      );
      sc.observe(`unpublished outbox rows overall: ${unpublishedAll}`);
    },
  );

  await ctx.runner.run(
    {
      id: 'log-secret-scan',
      name: 'Application logs contain no credentials',
      category: 'security',
      runId,
      mandatory: true,
      expected:
        'app logs since validation start contain no JWTs, Bearer headers, validation passwords/tokens or bcrypt hashes',
    },
    async (sc: ScenarioContext) => {
      const logs = await ctx.compose.fullLogsSince(
        'app',
        ctx.startedAt.toISOString(),
      );
      const lines = logs.split('\n').length;
      const leaks = ctx.redactor.findLeaks(logs);
      sc.observe(
        `scanned ${lines} app log lines since ${ctx.startedAt.toISOString()}`,
      );
      sc.check(
        leaks.length === 0,
        `SECURITY: credentials found in application logs: ${leaks.join(', ')}`,
      );
      sc.observe('no credential material found');
    },
  );
}
