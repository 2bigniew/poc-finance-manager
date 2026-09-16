// Deterministic, fake test configuration per TESTING.md - never the developer's real .env values.
process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000';

process.env.SQL_HOST ??= 'localhost';
process.env.SQL_PORT ??= '5432';
process.env.SQL_USERNAME ??= 'finance_manager';
process.env.SQL_PASSWORD ??= 'finance_manager_dev_password';
process.env.SQL_DBNAME ??= 'finance_manager_test';
process.env.SQL_POOL_MAX_SIZE ??= '5';
process.env.SQL_USE_SSL ??= 'false';
process.env.SQL_LOG ??= 'false';

process.env.KAFKA_BROKERS ??= 'localhost:9092';
process.env.KAFKA_CLIENT_ID ??= 'poc-finance-manager-test';
process.env.KAFKA_CONSUMER_GROUP ??= 'poc-finance-manager-test';
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= '1';

process.env.JWT_ACCESS_SECRET ??= 'test-only-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-only-refresh-secret';

process.env.FRANKFURTER_BASE_URL ??= 'https://api.frankfurter.dev';
process.env.HTTP_TIMEOUT_MS ??= '5000';
