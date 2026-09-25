import { tailLines } from '../support/shell';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import {
  APP_CONSUMER_GROUP,
  MigrationRun,
  TREASURY_TOPIC,
  ValidationContext,
  runIdFor,
} from '../support/validation-context';
import { waitFor } from '../support/wait';

const REQUIRED_SERVICES = ['postgres', 'kafka', 'app'];

export async function waitForAppReady(
  ctx: ValidationContext,
  timeoutMs: number,
): Promise<{ health: number; readiness: number }> {
  return waitFor(
    'application /health and /readiness to return 200',
    async () => {
      const health = await ctx.api.get('/health');
      const readiness = await ctx.api.get('/readiness');
      return health.status === 200 && readiness.status === 200
        ? { health: health.status, readiness: readiness.status }
        : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
}

export async function runInfrastructureScenarios(
  ctx: ValidationContext,
): Promise<boolean> {
  const runId = runIdFor(ctx, 'infra');
  const startupKey = scenarioKey(runId, 'compose-startup');

  await ctx.runner.run(
    {
      id: 'compose-startup',
      name: 'Docker Compose startup/build',
      category: 'infrastructure',
      runId,
      mandatory: true,
      expected: `docker compose up -d${ctx.options.build ? ' --build' : ''} succeeds; ${REQUIRED_SERVICES.join('/')} running and healthy`,
    },
    async (sc: ScenarioContext) => {
      const args = ctx.options.build ? ['up', '-d', '--build'] : ['up', '-d'];
      const result = await ctx.compose.run(args, { timeoutMs: 900_000 });
      sc.observe(
        `$ docker compose ${args.join(' ')} -> exit ${result.exitCode} in ${result.durationMs}ms`,
      );
      for (const line of tailLines(result.stderr, 8)) {
        sc.observe(`  ${line}`);
      }
      sc.check(
        result.exitCode === 0,
        `docker compose ${args.join(' ')} failed`,
      );

      const states = await ctx.compose.waitHealthy(REQUIRED_SERVICES, 240_000);
      for (const state of states) {
        sc.observe(
          `service ${state.service}: ${state.state}/${state.health || 'no-healthcheck'} (${state.image})`,
        );
      }
      ctx.infrastructure.services = states;
    },
  );

  await ctx.runner.run(
    {
      id: 'postgres-reachable',
      name: 'PostgreSQL reachable',
      category: 'infrastructure',
      runId,
      mandatory: true,
      expected: 'read-only SQL executes against the persistent database',
      dependsOn: [startupKey],
    },
    async (sc: ScenarioContext) => {
      const version = await ctx.db.scalar('SELECT version() AS v');
      sc.observe(`server: ${String(version).split(',')[0]}`);
      ctx.infrastructure.postgres = String(version).split(',')[0];
    },
  );

  await ctx.runner.run(
    {
      id: 'kafka-reachable',
      name: 'Kafka reachable',
      category: 'infrastructure',
      runId,
      mandatory: true,
      expected: `broker metadata readable; ${TREASURY_TOPIC} topic exists; application group ${APP_CONSUMER_GROUP} untouched by validation`,
      dependsOn: [startupKey],
    },
    async (sc: ScenarioContext) => {
      const topics = await ctx.kafka.listTopics();
      sc.observe(
        `topics: ${topics.filter((topic) => !topic.startsWith('test-')).join(', ')}`,
      );
      sc.observe(
        `(${topics.filter((topic) => topic.startsWith('test-')).length} isolated test-* topics from integration tests omitted)`,
      );
      sc.check(
        topics.includes(TREASURY_TOPIC),
        `topic ${TREASURY_TOPIC} missing`,
      );
      const partitions = await ctx.kafka.topicPartitionCount(TREASURY_TOPIC);
      sc.observe(`${TREASURY_TOPIC} partitions: ${partitions}`);
      ctx.infrastructure.kafka = {
        topicCount: topics.length,
        treasuryPartitions: partitions,
      };
    },
  );

  await ctx.runner.run(
    {
      id: 'health-readiness',
      name: 'Application /health and /readiness',
      category: 'infrastructure',
      runId,
      mandatory: true,
      expected: 'GET /health -> 200, GET /readiness -> 200 (postgres ok)',
      dependsOn: [startupKey],
    },
    async (sc: ScenarioContext) => {
      const statuses = await waitForAppReady(ctx, 120_000);
      const readiness = await ctx.api.get('/readiness');
      sc.observe(
        `/health=${statuses.health} /readiness=${statuses.readiness} body=${JSON.stringify(readiness.body)}`,
      );
      ctx.infrastructure.health = {
        health: statuses.health,
        readiness: readiness.body,
      };
    },
  );

  await ctx.runner.run(
    {
      id: 'baseline-snapshot',
      name: 'Pre-validation persistent data snapshot',
      category: 'persistence',
      runId,
      mandatory: true,
      expected:
        'existing row counts, applied migrations and up to 10 pre-existing Programs captured for later preservation checks',
      dependsOn: [scenarioKey(runId, 'postgres-reachable')],
    },
    async (sc: ScenarioContext) => {
      const counts = await ctx.db.tableCounts();
      const migrations = await ctx.db.appliedMigrations();
      const preExistingPrograms = await ctx.db.query(
        `SELECT id, name, total_capacity_usd_amount::text AS total_capacity_usd_amount, treasury_version, created_at
           FROM programs ORDER BY created_at LIMIT 10`,
      );
      ctx.baseline = { counts, migrations, preExistingPrograms };
      sc.observe(`row counts: ${JSON.stringify(counts)}`);
      sc.observe(
        `applied migrations: ${migrations.length} (latest ${migrations[migrations.length - 1] ?? 'none'})`,
      );
      sc.observe(
        `pre-existing programs snapshotted: ${preExistingPrograms.length}`,
      );
    },
  );

  return (
    ctx.runner.statusOf(scenarioKey(runId, 'health-readiness')) === 'PASS' &&
    ctx.runner.statusOf(scenarioKey(runId, 'baseline-snapshot')) === 'PASS'
  );
}

async function runMigrationCommand(
  ctx: ValidationContext,
  label: string,
): Promise<MigrationRun> {
  const countsBefore = await ctx.db.tableCounts();
  const appliedBefore = await ctx.db.appliedMigrations();
  const result = await ctx.compose.run(
    ['exec', '-T', 'app', 'node', 'dist/scripts/migrate.js', 'up'],
    { timeoutMs: 180_000 },
  );
  const run: MigrationRun = {
    label,
    exitCode: result.exitCode,
    output: tailLines(`${result.stdout}\n${result.stderr}`, 40).map((line) =>
      ctx.redactor.redact(line),
    ),
    appliedBefore,
    appliedAfter: await ctx.db.appliedMigrations(),
    countsBefore,
    countsAfter: await ctx.db.tableCounts(),
  };
  ctx.migrationRuns.push(run);
  return run;
}

export async function runMigrationScenario(
  ctx: ValidationContext,
  id: 'migrations-initial' | 'migrations-rerun',
): Promise<void> {
  const runId = runIdFor(ctx, 'infra');
  const rerun = id === 'migrations-rerun';

  await ctx.runner.run(
    {
      id,
      name: rerun
        ? 'Migration re-run is a safe no-op'
        : 'Run migrations against persistent database',
      category: 'migrations',
      runId,
      mandatory: true,
      expected: rerun
        ? 'exit 0; no migrations applied; applied set unchanged; no row removed'
        : 'exit 0; already-applied migrations untouched; pending ones applied; no row removed',
      dependsOn: [scenarioKey(runId, 'baseline-snapshot')],
    },
    async (sc: ScenarioContext) => {
      const run = await runMigrationCommand(ctx, id);
      sc.observe(
        '$ docker compose exec -T app node dist/scripts/migrate.js up',
      );
      sc.observe(`exit ${run.exitCode}`);
      if (run.output.length === 0) {
        sc.observe('output: (none) - no pending migrations');
      }
      for (const line of run.output) {
        sc.observe(`  ${line}`);
      }
      sc.check(run.exitCode === 0, 'migration command failed');

      const newlyApplied = run.appliedAfter.filter(
        (name) => !run.appliedBefore.includes(name),
      );
      sc.observe(
        `applied before=${run.appliedBefore.length} after=${run.appliedAfter.length} newly applied=[${newlyApplied.join(', ')}]`,
      );
      sc.check(
        run.appliedBefore.every((name) => run.appliedAfter.includes(name)),
        'a previously applied migration disappeared from kysely_migration',
      );
      if (rerun) {
        sc.check(
          newlyApplied.length === 0,
          'migration re-run applied migrations unexpectedly',
        );
      }

      const shrunk = Object.entries(run.countsBefore).filter(
        ([table, before]) => (run.countsAfter[table] ?? 0) < before,
      );
      sc.observe(`row counts before=${JSON.stringify(run.countsBefore)}`);
      sc.observe(`row counts after =${JSON.stringify(run.countsAfter)}`);
      sc.check(
        shrunk.length === 0,
        `BLOCKER: rows removed by migration in ${shrunk.map(([t]) => t).join(', ')}`,
      );
    },
  );

  await ctx.runner.run(
    {
      id: `${id}-safety`,
      name: rerun
        ? 'Pre-existing data intact after migration re-run'
        : 'Migration safety: pre-existing data intact',
      category: 'migrations',
      runId,
      mandatory: true,
      expected:
        'every pre-validation Program still present with identical id/name/total/treasuryVersion; row counts never below baseline',
      dependsOn: [scenarioKey(runId, id)],
    },
    async (sc: ScenarioContext) => {
      await expectBaselinePreserved(ctx, sc);
    },
  );
}

export async function expectBaselinePreserved(
  ctx: ValidationContext,
  sc: ScenarioContext,
): Promise<void> {
  const baseline = ctx.baseline;
  sc.check(baseline !== null, 'no baseline snapshot available');

  const counts = await ctx.db.tableCounts();
  const below = Object.entries(baseline.counts).filter(
    ([table, before]) => (counts[table] ?? 0) < before,
  );
  sc.check(
    below.length === 0,
    `BLOCKER: row counts below baseline in ${below.map(([t]) => t).join(', ')}`,
  );
  sc.observe(
    `all ${Object.keys(baseline.counts).length} tables at or above baseline counts`,
  );

  const ids = baseline.preExistingPrograms.map((row) => String(row.id));
  const current = await ctx.db.programSnapshot(ids);
  sc.check(
    current.length === ids.length,
    `pre-existing programs missing: expected ${ids.length}, found ${current.length}`,
  );
  for (const before of baseline.preExistingPrograms) {
    const after = current.find((row) => row.id === before.id);
    sc.check(
      after !== undefined &&
        after.name === before.name &&
        after.total_capacity_usd_amount === before.total_capacity_usd_amount &&
        after.treasury_version === before.treasury_version,
      `pre-existing program ${String(before.id)} changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
  sc.observe(
    `${ids.length} pre-existing programs unchanged (id/name/total/treasuryVersion)`,
  );
}
