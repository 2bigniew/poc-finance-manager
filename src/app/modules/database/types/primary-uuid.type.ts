import { ColumnType } from 'kysely';

// Primary key: app-generated at insert, immutable thereafter.
export type PrimaryUuid = ColumnType<string, string, never>;
