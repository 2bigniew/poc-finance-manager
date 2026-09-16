const REQUIRED_ENV: Record<string, string> = {
  SQL_HOST: 'localhost',
  SQL_PORT: '5432',
  SQL_USERNAME: 'finance_manager',
  SQL_PASSWORD: 'finance_manager_dev_password',
  SQL_DBNAME: 'finance_manager',
  KAFKA_BROKERS: 'localhost:9092',
  KAFKA_CONSUMER_GROUP: 'poc-finance-manager',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_USERNAME',
  'SQL_PASSWORD',
  'SQL_DBNAME',
  'SQL_POOL_MAX_SIZE',
  'SQL_USE_SSL',
  'SQL_CERT_PATH',
  'SQL_LOG',
  'KAFKA_BROKERS',
  'KAFKA_CLIENT_ID',
  'KAFKA_CONSUMER_GROUP',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_SECRET',
  'JWT_REFRESH_TTL',
  'JWT_ALGORITHM',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'BCRYPT_ROUNDS',
  'FRANKFURTER_BASE_URL',
  'HTTP_TIMEOUT_MS',
];

function resetProcessEnv(overrides: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  // Point dotenv at an empty file so a real developer .env in the repo root can't leak
  // values into this test and mask a variable we deliberately omitted.
  process.env.DOTENV_CONFIG_PATH = '/dev/null';

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function loadEnv(): typeof import('./env') {
  jest.resetModules();
  return require('./env') as typeof import('./env');
}

describe('env', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads valid configuration with the expected typed values', () => {
    resetProcessEnv(REQUIRED_ENV);

    const { env } = loadEnv();

    expect(env.SQL_HOST).toBe('localhost');
    expect(env.SQL_PORT).toBe(5432);
    expect(env.PORT).toBe(3000);
    expect(env.SQL_LOG).toBe(false);
  });

  it('fails startup when a required variable is missing', () => {
    const { SQL_HOST: _omitted, ...rest } = REQUIRED_ENV;
    resetProcessEnv(rest);

    expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
  });

  it('fails startup when access and refresh JWT secrets are identical', () => {
    resetProcessEnv({
      ...REQUIRED_ENV,
      JWT_REFRESH_SECRET: REQUIRED_ENV.JWT_ACCESS_SECRET,
    });

    expect(() => loadEnv()).toThrow(/must not be identical/);
  });
});
