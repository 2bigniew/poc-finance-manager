import { Kysely, sql } from 'kysely';

// Kept independent of the live Database type - migrations are immutable historical artifacts,
// and Kysely's FileMigrationProvider loads this file directly, so it must be self-contained.
type MigrationDb = Kysely<Record<string, never>>;

// pgcrypto provides gen_random_uuid(), required by every future entity's UUID primary key.
export async function up(db: MigrationDb): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS pgcrypto`.execute(db);
}
