import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthConfig } from '@config/auth.config';
import type { Request } from 'express';
import { RefreshTokenClaims } from '../tokens/token-claims.interface';

const extractRefreshToken = ExtractJwt.fromBodyField('refresh_token');

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(configService: ConfigService) {
    const authConfig = configService.getOrThrow<AuthConfig>('auth');

    super({
      jwtFromRequest: extractRefreshToken,
      secretOrKey: authConfig.refreshTokenSecret,
      algorithms: [authConfig.algorithm],
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      passReqToCallback: true,
    });
  }

  // Returns the raw refresh token (not the payload/AuthenticatedUser) - AuthService
  // re-derives everything it needs (server-side state, user) from the token itself.
  validate(request: Request, payload: RefreshTokenClaims): string {
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException();
    }

    const rawToken = extractRefreshToken(request);
    if (!rawToken) {
      throw new UnauthorizedException();
    }

    return rawToken;
  }
}
