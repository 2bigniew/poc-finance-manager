import { registerAs } from '@nestjs/config';
import { env } from './env';

export interface OutboxConfig {
  batchSize: number;
  pollIntervalMs: number;
}

export default registerAs('outbox', (): OutboxConfig => ({
  batchSize: env.OUTBOX_BATCH_SIZE,
  pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
}));
