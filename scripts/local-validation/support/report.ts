import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Redactor } from './redactor';
import {
  ScenarioCategory,
  ScenarioResult,
  ScenarioStatus,
} from './scenario-runner';
import { MigrationRun } from './validation-context';

export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  notExecuted: number;
  mandatoryNotPassed: number;
}

export interface ValidationReport {
  startedAt: string;
  finishedAt: string;
  git: { commit: string; branch: string; dirty: boolean };
  environment: Record<string, unknown>;
  iterations: { requested: number; completed: number; runIds: string[] };
  infrastructure: Record<string, unknown>;
  volumes: { before: unknown; after: unknown };
  migrations: MigrationRun[];
  baselineCounts: Record<string, number> | null;
  finalCounts: Record<string, number> | null;
  scenarios: ScenarioResult[];
  areas: { area: string; status: string }[];
  summary: Summary;
  knownLimitations: string[];
  commandsExecuted: string[];
  finalResult: 'PASS' | 'FAIL';
}

export function summarize(results: ScenarioResult[]): Summary {
  const count = (status: ScenarioStatus): number =>
    results.filter((result) => result.status === status).length;
  return {
    passed: count('PASS'),
    failed: count('FAIL'),
    skipped: count('SKIPPED'),
    notExecuted: count('NOT EXECUTED'),
    mandatoryNotPassed: results.filter(
      (result) => result.mandatory && result.status !== 'PASS',
    ).length,
  };
}

// Area roll-up for the terminal summary: FAIL if any scenario in the area failed or a
// mandatory one did not pass, NOT RUN if the area had no scenarios.
export function areaStatus(
  results: ScenarioResult[],
  matcher: (result: ScenarioResult) => boolean,
): string {
  const matching = results.filter(matcher);
  if (matching.length === 0) {
    return 'NOT RUN';
  }
  if (
    matching.some(
      (result) =>
        result.status === 'FAIL' ||
        (result.mandatory && result.status !== 'PASS'),
    )
  ) {
    return 'FAIL';
  }
  return matching.every((result) => result.status === 'PASS')
    ? 'PASS'
    : 'PASS (optional items skipped)';
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function scenarioTable(results: ScenarioResult[]): string[] {
  if (results.length === 0) {
    return ['_No scenarios in this section._', ''];
  }
  return [
    '| Result | runId | Scenario | Duration |',
    '|---|---|---|---|',
    ...results.map(
      (result) =>
        `| ${result.status}${result.mandatory ? '' : ' (optional)'} | \`${result.runId}\` | ${escapeCell(result.name)} | ${result.durationMs} ms |`,
    ),
    '',
  ];
}

function section(
  title: string,
  results: ScenarioResult[],
  categories: ScenarioCategory[],
): string[] {
  return [
    `## ${title}`,
    '',
    ...scenarioTable(
      results.filter((result) => categories.includes(result.category)),
    ),
  ];
}

function renderMarkdown(report: ValidationReport): string {
  const lines: string[] = [
    '# Local Validation Report',
    '',
    `- **Final result:** ${report.finalResult}`,
    `- **Started:** ${report.startedAt}`,
    `- **Finished:** ${report.finishedAt}`,
    `- **Git commit:** \`${report.git.commit}\` (${report.git.branch}${report.git.dirty ? ', working tree has uncommitted changes' : ''})`,
    `- **Docker Compose configuration:** \`compose.yaml\` (services: postgres, kafka, app)`,
    `- **Iterations:** requested ${report.iterations.requested}, completed ${report.iterations.completed}`,
    `- **Environment:** ${Object.entries(report.environment)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ')}`,
    '',
    '## Summary',
    '',
    `| PASS | FAIL | SKIPPED | NOT EXECUTED | Mandatory not passed |`,
    `|---|---|---|---|---|`,
    `| ${report.summary.passed} | ${report.summary.failed} | ${report.summary.skipped} | ${report.summary.notExecuted} | ${report.summary.mandatoryNotPassed} |`,
    '',
    '| Area | Result |',
    '|---|---|',
    ...report.areas.map((area) => `| ${area.area} | ${area.status} |`),
    '',
    '## Infrastructure',
    '',
    '```json',
    JSON.stringify(report.infrastructure, null, 2),
    '```',
    '',
    'Persistent volumes (CreatedAt proves they were never recreated):',
    '',
    '```json',
    JSON.stringify(report.volumes, null, 2),
    '```',
    '',
    '## Migration Result',
    '',
  ];

  for (const run of report.migrations) {
    const applied = run.appliedAfter.filter(
      (name) => !run.appliedBefore.includes(name),
    );
    lines.push(
      `### ${run.label}`,
      '',
      `- Command: \`docker compose exec -T app node dist/scripts/migrate.js up\` -> exit ${run.exitCode}`,
      `- Applied before: ${run.appliedBefore.length}, after: ${run.appliedAfter.length}, newly applied: ${applied.length === 0 ? 'none (no pending migrations)' : applied.join(', ')}`,
      `- Output: ${run.output.length === 0 ? '(none)' : ''}`,
      ...(run.output.length > 0 ? ['', '```', ...run.output, '```'] : []),
      `- Row counts before: \`${JSON.stringify(run.countsBefore)}\``,
      `- Row counts after: \`${JSON.stringify(run.countsAfter)}\``,
      '',
    );
  }

  lines.push(
    `Baseline row counts: \`${JSON.stringify(report.baselineCounts)}\``,
    '',
    `Final row counts: \`${JSON.stringify(report.finalCounts)}\``,
    '',
    ...section('Happy-Path Iterations', report.scenarios, ['happy-path']),
    ...section('Authentication Results', report.scenarios, [
      'authentication',
      'security',
    ]),
    ...section('Concurrency Results', report.scenarios, ['concurrency']),
    ...section('Release Idempotency Results', report.scenarios, [
      'release-idempotency',
    ]),
    ...section('Reconciliation Results', report.scenarios, ['reconciliation']),
    ...section('Kafka/Outbox Results', report.scenarios, ['kafka-outbox']),
    ...section('Restart/Recovery Results', report.scenarios, [
      'restart-recovery',
      'persistence',
    ]),
    ...section(
      'FX (Frankfurter) Results - reported separately from deterministic core',
      report.scenarios,
      ['fx'],
    ),
    ...section(
      'Integration-Test Validation (isolated test database, not Compose black-box)',
      report.scenarios,
      ['integration-tests'],
    ),
    ...section('Repository Automated Checks', report.scenarios, [
      'automated-tests',
    ]),
    '## Detailed Scenarios',
    '',
  );

  for (const result of report.scenarios) {
    lines.push(
      `### ${result.status} - ${result.name}`,
      '',
      `- runId: \`${result.runId}\``,
      `- scenario id: \`${result.id}\` (${result.category}${result.mandatory ? ', mandatory' : ', optional'})`,
      `- duration: ${result.durationMs} ms`,
      `- expected: ${result.expected}`,
    );
    const resources = Object.entries(result.resources);
    if (resources.length > 0) {
      lines.push(
        `- resources: ${resources.map(([key, value]) => `${key}=\`${value}\``).join(', ')}`,
      );
    }
    if (result.actual.length > 0) {
      lines.push('- actual:', ...result.actual.map((line) => `  - ${line}`));
    }
    if (result.error) {
      lines.push(`- **error:** ${result.error}`);
    }
    if (result.logExcerpt && result.logExcerpt.length > 0) {
      lines.push('- app log excerpt:', '', '```', ...result.logExcerpt, '```');
    }
    lines.push('');
  }

  lines.push(
    '## Commands Executed',
    '',
    ...report.commandsExecuted.map((command) => `- \`${command}\``),
    '',
    '## Known Limitations',
    '',
    ...report.knownLimitations.map((limitation) => `- ${limitation}`),
    '',
    '## Final Result',
    '',
    `**${report.finalResult}** - ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped, ${report.summary.notExecuted} not executed; ${report.summary.mandatoryNotPassed} mandatory scenario(s) did not pass.`,
    '',
  );
  return lines.join('\n');
}

// Writes both artifacts. Never overwrites an existing report: reports are historical.
export async function writeReports(
  reportDir: string,
  timestampTag: string,
  report: ValidationReport,
  redactor: Redactor,
): Promise<{ markdown: string; json: string }> {
  await mkdir(reportDir, { recursive: true });
  let base = path.join(reportDir, `local-validation-${timestampTag}`);
  for (
    let suffix = 2;
    existsSync(`${base}.md`) || existsSync(`${base}.json`);
    suffix += 1
  ) {
    base = path.join(reportDir, `local-validation-${timestampTag}-${suffix}`);
  }

  const markdown = `${base}.md`;
  const json = `${base}.json`;
  await writeFile(markdown, redactor.redact(renderMarkdown(report)), {
    flag: 'wx',
  });
  await writeFile(json, redactor.redact(JSON.stringify(report, null, 2)), {
    flag: 'wx',
  });
  return { markdown, json };
}
