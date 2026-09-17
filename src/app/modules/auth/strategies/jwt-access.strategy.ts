import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthConfig } from '@config/auth.config';
import { AuthenticatedUser } from '../authenticated-user.interface';
import { UserIdentityProvider } from '../identity/user-identity-provider.interface';
import { USER_IDENTITY_PROVIDER } from '../identity/user-identity-provider.token';
import { AccessTokenClaims } from '../tokens/token-claims.interface';

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(
  Strategy,
  'jwt-access',
) {
  constructor(
    configService: ConfigService,
    @Inject(USER_IDENTITY_PROVIDER)
    private readonly userIdentityProvider: UserIdentityProvider,
  ) {
    const authConfig = configService.getOrThrow<AuthConfig>('auth');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: authConfig.accessTokenSecret,
      algorithms: [authConfig.algorithm],
      issuer: authConfig.issuer,
      audience: authConfig.audience,
    });
  }

  async validate(payload: AccessTokenClaims): Promise<AuthenticatedUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException();
    }

    const identity = await this.userIdentityProvider.findById(payload.sub);
    if (!identity) {
      throw new UnauthorizedException();
    }

    return { id: identity.id, email: identity.email, authMethod: 'jwt' };
  }
}
