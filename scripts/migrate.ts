import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely';
import { createKysely } from '../src/app/modules/database/kysely.provider';

const migrationFolder = path.join(
  __dirname,
  '../src/app/modules/database/migrations',
);

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Usage: migrate.ts <up|down>');
  }

  const db = createKysely();
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });

  const { error, results } =
    direction === 'up'
      ? await migrator.migrateToLatest()
      : await migrator.migrateDown();

  for (const result of results ?? []) {
    if (result.status === 'Success') {
      console.log(
        `migration "${result.migrationName}" ${direction === 'up' ? 'applied' : 'reverted'} successfully`,
      );
    } else if (result.status === 'Error') {
      console.error(`migration "${result.migrationName}" failed`);
    }
  }

  await db.destroy();

  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
