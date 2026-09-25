import { Redactor } from './redactor';

export type ScenarioStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT EXECUTED';

export type ScenarioCategory =
  | 'infrastructure'
  | 'migrations'
  | 'happy-path'
  | 'authentication'
  | 'concurrency'
  | 'release-idempotency'
  | 'reconciliation'
  | 'kafka-outbox'
  | 'restart-recovery'
  | 'persistence'
  | 'fx'
  | 'security'
  | 'integration-tests'
  | 'automated-tests';

export interface ScenarioDefinition {
  id: string;
  name: string;
  category: ScenarioCategory;
  runId: string;
  mandatory: boolean;
  expected: string;
  dependsOn?: string[];
}

export interface ScenarioResult {
  key: string;
  id: string;
  name: string;
  category: ScenarioCategory;
  runId: string;
  mandatory: boolean;
  status: ScenarioStatus;
  startedAt: string;
  durationMs: number;
  expected: string;
  actual: string[];
  resources: Record<string, string>;
  error?: string;
  logExcerpt?: string[];
}

export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

export class ScenarioContext {
  readonly actual: string[] = [];
  readonly resources: Record<string, string> = {};

  constructor(readonly runId: string) {}

  resource(name: string, value: string): void {
    this.resources[name] = value;
  }

  observe(line: string): void {
    this.actual.push(line);
  }

  check(condition: boolean, message: string): asserts condition {
    if (!condition) {
      throw new AssertionFailure(message);
    }
  }
}

export function scenarioKey(runId: string, id: string): string {
  return `${runId}/${id}`;
}

type LogCollector = (sinceIso: string) => Promise<string[]>;

// Executes scenarios in isolation: a failing scenario is recorded and the run continues;
// scenarios whose declared dependencies did not pass are recorded as SKIPPED rather than
// silently omitted or reported as successful.
export class ScenarioRunner {
  readonly results: ScenarioResult[] = [];

  constructor(
    private readonly redactor: Redactor,
    private readonly collectLogs: LogCollector,
  ) {}

  statusOf(key: string): ScenarioStatus | undefined {
    return this.results.find((result) => result.key === key)?.status;
  }

  async run(
    definition: ScenarioDefinition,
    body: (ctx: ScenarioContext) => Promise<void>,
  ): Promise<boolean> {
    const blocking = (definition.dependsOn ?? []).filter(
      (dependency) => this.statusOf(dependency) !== 'PASS',
    );
    if (blocking.length > 0) {
      this.record(definition, 'SKIPPED', {
        error: `Dependency did not pass: ${blocking.join(', ')}`,
      });
      return false;
    }

    const ctx = new ScenarioContext(definition.runId);
    const started = new Date();
    try {
      await body(ctx);
      this.record(definition, 'PASS', { ctx, started });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let logExcerpt: string[] = [];
      try {
        logExcerpt = await this.collectLogs(started.toISOString());
      } catch {
        logExcerpt = ['(log collection failed)'];
      }
      this.record(definition, 'FAIL', {
        ctx,
        started,
        error: message,
        logExcerpt,
      });
      return false;
    }
  }

  record(
    definition: ScenarioDefinition,
    status: ScenarioStatus,
    details: {
      ctx?: ScenarioContext;
      started?: Date;
      error?: string;
      logExcerpt?: string[];
    } = {},
  ): void {
    const started = details.started ?? new Date();
    const result: ScenarioResult = {
      key: scenarioKey(definition.runId, definition.id),
      id: definition.id,
      name: definition.name,
      category: definition.category,
      runId: definition.runId,
      mandatory: definition.mandatory,
      status,
      startedAt: started.toISOString(),
      durationMs: details.started ? Date.now() - started.getTime() : 0,
      expected: definition.expected,
      actual: (details.ctx?.actual ?? []).map((line) =>
        this.redactor.redact(line),
      ),
      resources: details.ctx?.resources ?? {},
      error:
        details.error === undefined
          ? undefined
          : this.redactor.redact(details.error),
      logExcerpt: details.logExcerpt?.map((line) => this.redactor.redact(line)),
    };
    this.results.push(result);

    const suffix = result.error ? ` - ${result.error}` : '';
    console.log(
      `[${status}] ${definition.runId} :: ${definition.name} (${result.durationMs}ms)${suffix}`,
    );
  }
}
