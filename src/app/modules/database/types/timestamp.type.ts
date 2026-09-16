import { ColumnType } from 'kysely';

// Shared representation for every persisted timestamp column (timestamptz <-> Date).
export type Timestamp = ColumnType<Date, Date, Date>;
