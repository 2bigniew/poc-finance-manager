import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely';
// Jest's globalSetup runs outside the per-test-file sandbox, so moduleNameMapper does
// not apply here - register the same @app/@config aliases at the Node resolver level.
import 'tsconfig-paths/register';
import './setup-test-env';
import { createKysely } from '../src/app/modules/database/kysely.provider';

// Runs once before any integration/e2e test file in this Jest run. Idempotent - only
// pending migrations are applied - so it's safe even if a test file also migrates.
export default async function globalSetup(): Promise<void> {
  const db = createKysely();

  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(
          __dirname,
          '../src/app/modules/database/migrations',
        ),
      }),
    });

    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw error instanceof Error
        ? error
        : new Error(JSON.stringify(error) ?? 'Migration failed');
    }
  } finally {
    await db.destroy();
  }
}
