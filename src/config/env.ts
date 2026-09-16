import 'dotenv/config';
import { bool, cleanEnv, host, num, port, str, url } from 'envalid';

interface ReporterInput {
  errors: Record<string, Error>;
}

function throwingReporter({ errors }: ReporterInput): void {
  const invalidKeys = Object.keys(errors);
  if (invalidKeys.length === 0) {
    return;
  }

  const details = invalidKeys
    .map((key) => `${key}: ${errors[key]?.message ?? 'invalid value'}`)
    .join('; ');
  throw new Error(`Invalid environment configuration - ${details}`);
}

export const env = cleanEnv(
  process.env,
  {
    NODE_ENV: str({
      choices: ['development', 'test', 'production'],
      default: 'development',
    }),
    PORT: port({ default: 3000 }),

    SQL_HOST: host(),
    SQL_PORT: port({ default: 5432 }),
    SQL_USERNAME: str(),
    SQL_PASSWORD: str(),
    SQL_DBNAME: str(),
    SQL_POOL_MAX_SIZE: num({ default: 10 }),
    SQL_USE_SSL: bool({ default: false }),
    SQL_CERT_PATH: str({ default: '' }),
    SQL_LOG: bool({ default: false }),

    KAFKA_BROKERS: str(),
    KAFKA_CLIENT_ID: str({ default: 'poc-finance-manager' }),
    KAFKA_CONSUMER_GROUP: str(),

    JWT_ACCESS_SECRET: str(),
    JWT_ACCESS_TTL: str({ default: '15m' }),
    JWT_REFRESH_SECRET: str(),
    JWT_REFRESH_TTL: str({ default: '7d' }),
    JWT_ALGORITHM: str({ default: 'HS256' }),
    JWT_ISSUER: str({ default: 'poc-finance-manager' }),
    JWT_AUDIENCE: str({ default: 'poc-finance-manager-clients' }),
    BCRYPT_ROUNDS: num({ default: 12 }),

    FRANKFURTER_BASE_URL: url({ default: 'https://api.frankfurter.dev' }),
    HTTP_TIMEOUT_MS: num({ default: 5000 }),
  },
  { reporter: throwingReporter },
);

if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
  throw new Error(
    'Invalid environment configuration - JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must not be identical.',
  );
}
