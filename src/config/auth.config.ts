import { registerAs } from '@nestjs/config';
import { env } from './env';

export interface AuthConfig {
  accessTokenSecret: string;
  accessTokenTtl: string;
  refreshTokenSecret: string;
  refreshTokenTtl: string;
  algorithm: string;
  issuer: string;
  audience: string;
  bcryptRounds: number;
}

export default registerAs('auth', (): AuthConfig => ({
  accessTokenSecret: env.JWT_ACCESS_SECRET,
  accessTokenTtl: env.JWT_ACCESS_TTL,
  refreshTokenSecret: env.JWT_REFRESH_SECRET,
  refreshTokenTtl: env.JWT_REFRESH_TTL,
  algorithm: env.JWT_ALGORITHM,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  bcryptRounds: env.BCRYPT_ROUNDS,
}));
