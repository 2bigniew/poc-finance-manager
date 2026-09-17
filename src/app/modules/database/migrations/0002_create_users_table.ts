import { Kysely } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// id/createdAt/updatedAt are application-generated (see UsersService), so no DB-side
// defaults - the app is always expected to supply them at insert time.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.notNull())
    .addColumn('password_hash', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('users_email_key')
    .on('users')
    .column('email')
    .unique()
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('users').execute();
}
