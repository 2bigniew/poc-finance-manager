import * as path from 'node:path';
import { runAuthenticationScenarios } from './scenarios/authentication';
import { runConcurrencyScenarios } from './scenarios/concurrency';
import {
  runFinalChecks,
  runTrackedProgramsCheck,
} from './scenarios/final-checks';
import {
  runFrankfurterFailureScenario,
  runFrankfurterSmokeScenario,
} from './scenarios/fx';
import { runHappyPathIteration } from './scenarios/happy-path';
import {
  runInfrastructureScenarios,
  runMigrationScenario,
} from './scenarios/infrastructure';
import { runReconciliationScenarios } from './scenarios/reconciliation';
import { runReleaseIdempotencyScenarios } from './scenarios/release-idempotency';
import {
  runAppRestartScenarios,
  runKafkaOutageScenario,
} from './scenarios/recovery';
import { runRepositoryChecks } from './scenarios/repository-checks';
import { ApiClient } from './support/api-client';
import { Compose } from './support/compose';
import { DatabaseProbe } from './support/database-probe';
import { KafkaProbe } from './support/kafka-probe';
import { Redactor } from './support/redactor';
import {
  ValidationReport,
  areaStatus,
  summarize,
  writeReports,
} from './support/report';
import { ScenarioResult, ScenarioRunner } from './support/scenario-runner';
import { runCommand } from './support/shell';
import {
  APP_CONSUMER_GROUP,
  ValidationContext,
  ValidationOptions,
  runIdFor,
} from './support/validation-context';

// Black-box validation of the running Docker Compose environment against persistent
// PostgreSQL/Kafka state. Never deletes volumes, truncates tables, resets topics or
// consumer groups, or mutates application tables directly; every run namespaces its data
// under `validation-<UTC timestamp>-*` so it can be repeated without cleanup.
//
//   npm run validate:local -- --iterations=3 [--no-build] [--repo-checks]

const USAGE = `Usage: npm run validate:local -- [--iterations=N] [--no-build] [--repo-checks]
  [--base-url=http://localhost:3000] [--kafka-brokers=localhost:9092] [--report-dir=reports]`;

function parseOptions(argv: string[], projectDir: string): ValidationOptions {
  const options: ValidationOptions = {
    iterations: 3,
    build: true,
    repoChecks: false,
    baseUrl: 'http://localhost:3000',
    kafkaBrokers: ['localhost:9092'],
    reportDir: path.join(projectDir, 'reports'),
  };

  for (const arg of argv) {
    const [flag, value] = arg.split('=', 2);
    if (
      flag === '--iterations' &&
      value !== undefined &&
      /^\d+$/.test(value) &&
      Number(value) >= 1
    ) {
      options.iterations = Number(value);
    } else if (flag === '--no-build') {
      options.build = false;
    } else if (flag === '--repo-checks') {
      options.repoChecks = true;
    } else if (flag === '--base-url' && value) {
      options.baseUrl = value;
    } else if (flag === '--kafka-brokers' && value) {
      options.kafkaBrokers = value.split(',').map((broker) => broker.trim());
    } else if (flag === '--report-dir' && value) {
      options.reportDir = path.resolve(projectDir, value);
    } else {
      throw new Error(`Unknown or invalid argument "${arg}"\n${USAGE}`);
    }
  }
  return options;
}

async function gitInfo(projectDir: string): Promise<ValidationReport['git']> {
  const commit = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: projectDir,
  });
  const branch = await runCommand(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: projectDir },
  );
  const status = await runCommand('git', ['status', '--porcelain'], {
    cwd: projectDir,
  });
  return {
    commit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  };
}

async function volumeState(
  compose: Compose,
  projectDir: string,
): Promise<unknown> {
  const config = await compose.run(['config', '--format', 'json']);
  const parsed: unknown = JSON.parse(config.stdout);
  const record =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const volumes =
    typeof record.volumes === 'object' && record.volumes !== null
      ? (record.volumes as Record<string, unknown>)
      : {};
  const names = Object.values(volumes)
    .map((volume) =>
      typeof volume === 'object' && volume !== null
        ? (volume as Record<string, unknown>).name
        : undefined,
    )
    .filter((name): name is string => typeof name === 'string');
  const inspect = await runCommand(
    'docker',
    ['volume', 'inspect', ...names, '--format', '{{.Name}} {{.CreatedAt}}'],
    { cwd: projectDir },
  );
  return inspect.stdout.trim().split('\n');
}

function knownLimitations(ctx: ValidationContext): string[] {
  return [
    'Reconciliation redelivery after restart is exercised by republishing the identical logical event after the restart; consumer-group offsets were deliberately not manipulated. Uncommitted-offset redelivery with real Kafka is covered by reconciliations.kafka.integration-spec.ts and the broker-kafka consumer integration specs.',
    'The treasury wire contract carries no per-entry externalEventId; the application derives "<batchId>:<programId>:<sourceVersion>" and that derived value is what reports list as externalEventId.',
    'PostgreSQL rollback (Reservation/Release/Reconciliation) cannot be triggered through the running Compose app without fault injection; ' +
      (ctx.options.repoChecks
        ? 'it is validated by the targeted rollback integration tests in this report (isolated finance_manager_test database).'
        : 'rollback integration tests were not run in this execution (use --repo-checks).'),
    'The live Frankfurter smoke test depends on the public internet and is optional; the FX-unavailable scenario temporarily recreates the app container with a compose override file (no source change) and restores it afterwards.',
    'The FX-unavailable scenario and app restart both recreate/restart only the app container; PostgreSQL and Kafka volumes are never touched (see volume CreatedAt values).',
    'Integration/E2E suites use the isolated finance_manager_test database but share the Compose Kafka broker (unique test-* topics/groups; E2E boots the full AppModule with consumer group poc-finance-manager-test and its own outbox publisher).',
    'Validation data accumulates by design; all rows are namespaced by runId (emails validation+<runId>@example.com, Program names "Validation Program <runId>", invoice references VALIDATION-<runId>-*).',
  ];
}

function markRemainingNotExecuted(
  ctx: ValidationContext,
  reason: string,
): void {
  const runId = runIdFor(ctx, 'blocked');
  const phases = [
    'migrations',
    'happy-path iterations',
    'authentication',
    'concurrency',
    'release idempotency',
    'reconciliation',
    'kafka outage / outbox recovery',
    'application restart / persistence',
  ];
  for (const phase of phases) {
    ctx.runner.record(
      {
        id: phase.replace(/[^a-z]+/g, '-'),
        name: `Phase: ${phase}`,
        category: 'infrastructure',
        runId,
        mandatory: true,
        expected: 'phase executed',
      },
      'NOT EXECUTED',
      { error: reason },
    );
  }
}

async function main(): Promise<number> {
  const projectDir = path.resolve(__dirname, '../..');
  const options = parseOptions(process.argv.slice(2), projectDir);
  const startedAt = new Date();
  const timestampTag = startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const redactor = new Redactor();
  const commandLog: string[] = [];
  const compose = new Compose(projectDir, commandLog);

  const ctx: ValidationContext = {
    options,
    projectDir,
    timestampTag,
    startedAt,
    compose,
    db: new DatabaseProbe(compose),
    kafka: new KafkaProbe(
      options.kafkaBrokers,
      `local-validation-${timestampTag}`,
      [APP_CONSUMER_GROUP],
    ),
    api: new ApiClient(options.baseUrl, 30_000),
    redactor,
    runner: new ScenarioRunner(redactor, (since) =>
      compose.logsSince('app', since, 40),
    ),
    trackedPrograms: [],
    baseline: null,
    infrastructure: {},
    migrationRuns: [],
  };

  console.log(
    `Local validation validation-${timestampTag}-* (iterations=${options.iterations}, build=${options.build}, repoChecks=${options.repoChecks})`,
  );
  const git = await gitInfo(projectDir);
  const volumesBefore = await volumeState(compose, projectDir);

  const iterationRunIds: string[] = [];
  let completedIterations = 0;

  if (await runInfrastructureScenarios(ctx)) {
    await runMigrationScenario(ctx, 'migrations-initial');

    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const runId = runIdFor(ctx, String(iteration).padStart(2, '0'));
      iterationRunIds.push(runId);
      if (await runHappyPathIteration(ctx, runId)) {
        completedIterations += 1;
      }
    }
    await runTrackedProgramsCheck(
      ctx,
      runIdFor(ctx, 'iterations'),
      'iterations-persist',
      'Earlier iterations still intact after repeated runs',
    );

    await runAuthenticationScenarios(ctx);
    await runConcurrencyScenarios(ctx);
    await runReleaseIdempotencyScenarios(ctx);
    await runReconciliationScenarios(ctx);
    await runKafkaOutageScenario(ctx);
    await runFrankfurterSmokeScenario(ctx);
    await runFrankfurterFailureScenario(ctx);
    await runAppRestartScenarios(ctx);

    const postRestartRunId = runIdFor(ctx, 'post-restart');
    iterationRunIds.push(postRestartRunId);
    await runHappyPathIteration(ctx, postRestartRunId);

    await runMigrationScenario(ctx, 'migrations-rerun');
    await runFinalChecks(ctx);
  } else {
    markRemainingNotExecuted(ctx, 'infrastructure/readiness did not pass');
  }

  if (options.repoChecks) {
    await runRepositoryChecks(ctx);
  }

  let finalCounts: Record<string, number> | null = null;
  try {
    finalCounts = await ctx.db.tableCounts();
  } catch {
    finalCounts = null;
  }

  const results = ctx.runner.results;
  const byIds =
    (...ids: string[]) =>
    (result: ScenarioResult): boolean =>
      ids.includes(result.id);
  const byCategory =
    (...categories: string[]) =>
    (result: ScenarioResult): boolean =>
      categories.includes(result.category);
  const areas = [
    ['Infrastructure', byCategory('infrastructure')],
    ['Migrations', byCategory('migrations')],
    ['Happy path', byCategory('happy-path')],
    ['Authentication', byCategory('authentication', 'security')],
    ['Concurrency', byCategory('concurrency')],
    ['Release idempotency', byCategory('release-idempotency')],
    ['Reconciliation', byCategory('reconciliation')],
    [
      'Kafka redelivery/idempotency',
      byIds(
        'reconciliation-duplicate',
        'reconciliation-redelivery-after-restart',
      ),
    ],
    [
      'Outbox recovery',
      byIds(
        'kafka-unavailable-outbox-recovery',
        'outbox-resumes-after-restart',
        'outbox-drained',
      ),
    ],
    ['Restart persistence', byCategory('restart-recovery', 'persistence')],
    ['FX (optional, separate)', byCategory('fx')],
    ['Automated tests', byCategory('automated-tests', 'integration-tests')],
  ] as const;

  const summary = summarize(results);
  const report: ValidationReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    git,
    environment: {
      node: process.version,
      baseUrl: options.baseUrl,
      kafkaBrokers: options.kafkaBrokers.join(','),
      build: options.build,
      repoChecks: options.repoChecks,
    },
    iterations: {
      requested: options.iterations,
      completed: completedIterations,
      runIds: iterationRunIds,
    },
    infrastructure: ctx.infrastructure,
    volumes: {
      before: volumesBefore,
      after: await volumeState(compose, projectDir),
    },
    migrations: ctx.migrationRuns,
    baselineCounts: ctx.baseline?.counts ?? null,
    finalCounts,
    scenarios: results,
    areas: areas.map(([area, matcher]) => ({
      area,
      status: areaStatus(results, matcher),
    })),
    summary,
    knownLimitations: knownLimitations(ctx),
    commandsExecuted: [
      ...commandLog,
      'docker compose exec -T postgres psql ... (read-only session: default_transaction_read_only=on)',
      'docker compose ps / docker compose logs (polling, log excerpts, secret scan)',
    ],
    finalResult:
      summary.mandatoryNotPassed === 0 && summary.failed === 0
        ? 'PASS'
        : 'FAIL',
  };

  const paths = await writeReports(
    options.reportDir,
    timestampTag,
    report,
    redactor,
  );

  const areaWidth = Math.max(...report.areas.map((area) => area.area.length));
  console.log('\n================ Local validation summary ================');
  console.log(`Iterations requested: ${options.iterations}`);
  console.log(`Iterations completed: ${completedIterations}`);
  for (const area of report.areas) {
    console.log(`${`${area.area}:`.padEnd(areaWidth + 2)}${area.status}`);
  }
  console.log(
    `\nScenarios: ${summary.passed} PASS, ${summary.failed} FAIL, ${summary.skipped} SKIPPED, ${summary.notExecuted} NOT EXECUTED`,
  );
  console.log(`Final result: ${report.finalResult}`);
  console.log(
    `\nReport:\n${path.relative(projectDir, paths.markdown)}\n${path.relative(projectDir, paths.json)}`,
  );

  return report.finalResult === 'PASS' ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
