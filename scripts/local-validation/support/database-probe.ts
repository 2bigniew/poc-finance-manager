import { Compose } from './compose';

export type DbRow = Record<string, unknown>;

export const APPLICATION_TABLES = [
  'users',
  'refresh_tokens',
  'programs',
  'invoices',
  'reservations',
  'releases',
  'reconciliations',
  'reservation_events',
  'release_events',
  'reconciliation_events',
  'outbox_events',
] as const;

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Read-only assertions against the persistent database. Queries run through psql inside
// the postgres container, authenticating with the container's own environment, so no
// database credential ever passes through this process or its reports. Every session is
// forced read-only (`default_transaction_read_only`), so a mistake here cannot mutate
// application tables.
export class DatabaseProbe {
  constructor(private readonly compose: Compose) {}

  async query(sql: string): Promise<DbRow[]> {
    const script = [
      'SET default_transaction_read_only = on;',
      `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t;`,
    ].join('\n');

    const result = await this.compose.run(
      [
        'exec',
        '-T',
        'postgres',
        'sh',
        '-c',
        'psql -qAtX -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ],
      { input: script, timeoutMs: 30_000 },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Read-only SQL failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!Array.isArray(parsed)) {
      throw new Error('Read-only SQL did not return a JSON array');
    }
    return parsed as DbRow[];
  }

  async scalar(sql: string): Promise<unknown> {
    const rows = await this.query(sql);
    const first = rows[0];
    if (first === undefined) {
      return null;
    }
    return Object.values(first)[0] ?? null;
  }

  async count(sql: string): Promise<number> {
    return Number(
      await this.scalar(`SELECT count(*)::int AS n FROM (${sql}) c`),
    );
  }

  async tableCounts(): Promise<Record<string, number>> {
    const union = APPLICATION_TABLES.map(
      (table) =>
        `SELECT ${sqlLiteral(table)} AS table_name, count(*)::int AS n FROM ${table}`,
    ).join(' UNION ALL ');
    const rows = await this.query(union);

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[String(row.table_name)] = Number(row.n);
    }
    return counts;
  }

  async appliedMigrations(): Promise<string[]> {
    const rows = await this.query(
      'SELECT name FROM kysely_migration ORDER BY name',
    );
    return rows.map((row) => String(row.name));
  }

  async programSnapshot(programIds: string[]): Promise<DbRow[]> {
    if (programIds.length === 0) {
      return [];
    }
    return this.query(
      `SELECT id, name, total_capacity_usd_amount::text AS total_capacity_usd_amount, treasury_version, created_at
         FROM programs
        WHERE id IN (${programIds.map(sqlLiteral).join(', ')})
        ORDER BY id`,
    );
  }
}
