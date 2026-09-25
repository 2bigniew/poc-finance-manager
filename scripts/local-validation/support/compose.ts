import { CommandResult, runCommand, tailLines } from './shell';
import { sleep } from './wait';

export interface ServiceState {
  service: string;
  state: string;
  health: string;
  image: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseServiceState(value: unknown): ServiceState | null {
  if (!isRecord(value) || typeof value.Service !== 'string') {
    return null;
  }

  return {
    service: value.Service,
    state: typeof value.State === 'string' ? value.State : 'unknown',
    health: typeof value.Health === 'string' ? value.Health : '',
    image: typeof value.Image === 'string' ? value.Image : '',
  };
}

// Every Docker Compose interaction of the validation goes through here. There is
// deliberately no method for `down -v`, `volume rm`, or anything else that could remove
// persistent PostgreSQL/Kafka data.
export class Compose {
  constructor(
    private readonly projectDir: string,
    private readonly commandLog: string[],
    private readonly extraFiles: string[] = [],
  ) {}

  withOverrideFile(file: string): Compose {
    return new Compose(this.projectDir, this.commandLog, [
      ...this.extraFiles,
      file,
    ]);
  }

  run(
    args: string[],
    options: { input?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const fileArgs =
      this.extraFiles.length === 0
        ? []
        : [
            '-f',
            'compose.yaml',
            ...this.extraFiles.flatMap((file) => ['-f', file]),
          ];

    const printable = ['docker', 'compose', ...fileArgs, ...args].join(' ');
    // Polling/read-only probes (ps, logs, psql) are summarized rather than listed.
    const quiet =
      args[0] === 'ps' ||
      args[0] === 'logs' ||
      (args[0] === 'exec' && args[2] === 'postgres');
    if (!quiet && !this.commandLog.includes(printable)) {
      this.commandLog.push(printable);
    }

    return runCommand('docker', ['compose', ...fileArgs, ...args], {
      cwd: this.projectDir,
      ...options,
    });
  }

  async serviceStates(): Promise<ServiceState[]> {
    const result = await this.run(['ps', '--all', '--format', 'json']);
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) {
      return [];
    }

    // Compose v2.21+ prints one JSON object per line; older versions print an array.
    const raw: unknown[] = trimmed.startsWith('[')
      ? (JSON.parse(trimmed) as unknown[])
      : trimmed.split('\n').map((line): unknown => JSON.parse(line));

    return raw
      .map(parseServiceState)
      .filter((state): state is ServiceState => state !== null);
  }

  // Bounded polling until every named service is running and (where a healthcheck
  // exists) healthy.
  async waitHealthy(
    services: string[],
    timeoutMs: number,
  ): Promise<ServiceState[]> {
    const deadline = Date.now() + timeoutMs;
    let states: ServiceState[] = [];

    while (Date.now() < deadline) {
      states = await this.serviceStates();
      const ready = services.every((service) => {
        const state = states.find((candidate) => candidate.service === service);
        return (
          state !== undefined &&
          state.state === 'running' &&
          (state.health === '' || state.health === 'healthy')
        );
      });
      if (ready) {
        return states;
      }
      await sleep(2_000);
    }

    const summary = states
      .map((state) => `${state.service}=${state.state}/${state.health}`)
      .join(', ');
    throw new Error(
      `Services ${services.join(', ')} not healthy within ${timeoutMs}ms (${summary})`,
    );
  }

  async waitStopped(service: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const states = await this.serviceStates();
      const state = states.find((candidate) => candidate.service === service);
      if (state === undefined || state.state !== 'running') {
        return;
      }
      await sleep(1_000);
    }
    throw new Error(`Service ${service} still running after ${timeoutMs}ms`);
  }

  async logsSince(
    service: string,
    sinceIso: string,
    maxLines: number,
  ): Promise<string[]> {
    const result = await this.run([
      'logs',
      '--no-color',
      '--since',
      sinceIso,
      service,
    ]);
    return tailLines(`${result.stdout}\n${result.stderr}`, maxLines);
  }

  async fullLogsSince(service: string, sinceIso: string): Promise<string> {
    const result = await this.run(
      ['logs', '--no-color', '--since', sinceIso, service],
      { timeoutMs: 60_000 },
    );
    return `${result.stdout}\n${result.stderr}`;
  }
}
