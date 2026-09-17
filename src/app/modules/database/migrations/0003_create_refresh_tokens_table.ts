import { Kysely } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// id/createdAt/updatedAt are application-generated (see AuthService), so no DB-side
// defaults - the app is always expected to supply them at insert time.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('refresh_tokens')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('refresh_tokens_token_hash_key')
    .on('refresh_tokens')
    .column('token_hash')
    .unique()
    .execute();

  await db.schema
    .createIndex('refresh_tokens_user_id_idx')
    .on('refresh_tokens')
    .column('user_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('refresh_tokens').execute();
}
