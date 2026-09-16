import { registerAs } from '@nestjs/config';
import { env } from './env';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  poolMaxSize: number;
  useSsl: boolean;
  certPath: string | undefined;
  logSql: boolean;
}

export default registerAs('database', (): DatabaseConfig => ({
  host: env.SQL_HOST,
  port: env.SQL_PORT,
  username: env.SQL_USERNAME,
  password: env.SQL_PASSWORD,
  database: env.SQL_DBNAME,
  poolMaxSize: env.SQL_POOL_MAX_SIZE,
  useSsl: env.SQL_USE_SSL,
  certPath: env.SQL_CERT_PATH.length > 0 ? env.SQL_CERT_PATH : undefined,
  logSql: env.SQL_LOG,
}));
