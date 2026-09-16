import { registerAs } from '@nestjs/config';
import { env } from './env';

export interface AppConfig {
  nodeEnv: string;
  port: number;
}

export default registerAs('app', (): AppConfig => ({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
}));
