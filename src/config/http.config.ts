import { registerAs } from '@nestjs/config';
import { env } from './env';

export interface HttpClientConfig {
  timeoutMs: number;
  frankfurterBaseUrl: string;
}

export default registerAs('http', (): HttpClientConfig => ({
  timeoutMs: env.HTTP_TIMEOUT_MS,
  frankfurterBaseUrl: env.FRANKFURTER_BASE_URL,
}));
