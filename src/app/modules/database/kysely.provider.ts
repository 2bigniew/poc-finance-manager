import { CamelCasePlugin, Kysely, KyselyConfig, PostgresDialect } from 'kysely';
import Cursor from 'pg-cursor';
import { Pool, types } from 'pg';
import { env } from '@config/env';
import { Database } from './types/database.interface';

const logParamSerializer = (param: unknown): string => {
  if (param instanceof Date) {
    return param.toISOString();
  } else if (param === null) {
    return 'null';
  } else if (typeof param === 'string') {
    return `'${param}'`;
  }

  return JSON.stringify(param) ?? '';
};

const int8TypeId = 20;
types.setTypeParser(int8TypeId, (val) => parseInt(val, 10));

export const KYSELY_CONFIG: KyselyConfig = {
  dialect: new PostgresDialect({
    cursor: Cursor,
    pool: new Pool({
      host: env.SQL_HOST,
      port: env.SQL_PORT,
      user: env.SQL_USERNAME,
      password: env.SQL_PASSWORD,
      database: env.SQL_DBNAME,
      max: env.SQL_POOL_MAX_SIZE,
      ssl: env.SQL_USE_SSL
        ? env.SQL_CERT_PATH
          ? { ca: env.SQL_CERT_PATH, rejectUnauthorized: false }
          : true
        : false,
      connectionTimeoutMillis: 10_000,
      idle_in_transaction_session_timeout: 60_000,
    }),
  }),
  log: !env.SQL_LOG
    ? undefined
    : (event) => {
        const sql = `sql: ${event.query.sql} [${event.query.parameters.map(logParamSerializer).join(', ')}]`;
        const errorStr =
          event.level === 'error'
            ? `${event.error?.toString?.() ?? 'unknown error'}`
            : undefined;
        const msg = [sql, errorStr].filter(Boolean).join(', ');

        console.log(msg);
      },
  plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: false })],
};

export function createKysely(): Kysely<Database> {
  return new Kysely<Database>(KYSELY_CONFIG);
}
