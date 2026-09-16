import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileMigrationProvider, Kysely, Migrator, sql } from 'kysely';
import { createKysely } from './kysely.provider';
import { Database } from './types/database.interface';

describe('DatabaseModule Postgres integration', () => {
  let db: Kysely<Database>;
  let migrator: Migrator;

  beforeAll(() => {
    db = createKysely();
    migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, 'migrations'),
      }),
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('connects to PostgreSQL and executes a query', async () => {
    const result = await sql<{ value: number }>`select 1 as value`.execute(db);

    expect(result.rows[0]?.value).toBe(1);
  });

  it('applies and reverts the pgcrypto bootstrap migration', async () => {
    const upResult = await migrator.migrateToLatest();
    expect(upResult.error).toBeUndefined();

    const generated = await sql<{
      id: string;
    }>`select gen_random_uuid() as id`.execute(db);
    expect(generated.rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const downResult = await migrator.migrateDown();
    expect(downResult.error).toBeUndefined();
  });
});
