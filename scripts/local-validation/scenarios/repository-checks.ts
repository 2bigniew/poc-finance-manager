import { runCommand, tailLines } from '../support/shell';
import { ScenarioContext, ScenarioCategory } from '../support/scenario-runner';
import { ValidationContext, runIdFor } from '../support/validation-context';

interface RepositoryCheck {
  id: string;
  name: string;
  category: ScenarioCategory;
  args: string[];
  expected: string;
}

// Targeted real-PostgreSQL rollback tests (TESTING.md) - these cannot be triggered
// safely through the running Compose application, so they run as isolated integration
// tests against the dedicated finance_manager_test database.
const ROLLBACK_SPECS = [
  'src/app/modules/domain/reservations/reservations.concurrency.integration-spec.ts',
  'src/app/modules/domain/releases/releases.concurrency.integration-spec.ts',
  'src/app/modules/domain/reconciliations/reconciliations.integration-spec.ts',
];

const CHECKS: RepositoryCheck[] = [
  {
    id: 'rollback-integration-tests',
    name: 'Rollback integration tests (Reservation/Release/Reconciliation)',
    category: 'integration-tests',
    args: [
      'jest',
      '-c',
      'jest.integration.config.ts',
      '--runInBand',
      '-t',
      'rolls? back',
      ...ROLLBACK_SPECS,
    ],
    expected:
      'transaction rollback tests pass against the isolated finance_manager_test database',
  },
  {
    id: 'format-check',
    name: 'npm run format:check',
    category: 'automated-tests',
    args: ['npm', 'run', 'format:check'],
    expected: 'exit 0',
  },
  {
    id: 'lint',
    name: 'npm run lint',
    category: 'automated-tests',
    args: ['npm', 'run', 'lint'],
    expected: 'exit 0',
  },
  {
    id: 'typecheck',
    name: 'npm run typecheck',
    category: 'automated-tests',
    args: ['npm', 'run', 'typecheck'],
    expected: 'exit 0',
  },
  {
    id: 'test-unit',
    name: 'npm run test:unit',
    category: 'automated-tests',
    args: ['npm', 'run', 'test:unit'],
    expected: 'exit 0',
  },
  {
    id: 'test-integration',
    name: 'npm run test:integration',
    category: 'automated-tests',
    args: ['npm', 'run', 'test:integration'],
    expected: 'exit 0 (isolated test database)',
  },
  {
    id: 'test-e2e',
    name: 'npm run test:e2e',
    category: 'automated-tests',
    args: ['npm', 'run', 'test:e2e'],
    expected: 'exit 0 (isolated test database)',
  },
  {
    id: 'build',
    name: 'npm run build',
    category: 'automated-tests',
    args: ['npm', 'run', 'build'],
    expected: 'exit 0',
  },
];

export async function runRepositoryChecks(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'repo-checks');

  for (const check of CHECKS) {
    await ctx.runner.run(
      {
        id: check.id,
        name: check.name,
        category: check.category,
        runId,
        mandatory: true,
        expected: check.expected,
      },
      async (sc: ScenarioContext) => {
        const [command, ...args] =
          check.args[0] === 'jest' ? ['npx', ...check.args] : check.args;
        const result = await runCommand(command ?? 'npm', args, {
          cwd: ctx.projectDir,
          timeoutMs: 1_200_000,
        });
        sc.observe(
          `$ ${result.command} -> exit ${result.exitCode} in ${Math.round(result.durationMs / 1000)}s`,
        );
        const summary = tailLines(
          `${result.stdout}\n${result.stderr}`,
          200,
        ).filter((line) =>
          /^(Tests:|Test Suites:|Snapshots:|Time:)|✕|problems?|error|warning|Code style issues|All matched files/i.test(
            line.trim(),
          ),
        );
        for (const line of summary.slice(-15)) {
          sc.observe(`  ${line.trim()}`);
        }
        sc.check(!result.timedOut, 'command timed out');
        sc.check(
          result.exitCode === 0,
          `${check.name} failed (exit ${result.exitCode})`,
        );
      },
    );
  }
}
