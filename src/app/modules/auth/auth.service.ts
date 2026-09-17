import { createHash, randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Kysely } from 'kysely';
import { AuthConfig } from '@config/auth.config';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { CreateUserDto } from '@app/modules/domain/users/dto/create-user.dto';
import { User } from '@app/modules/domain/users/user.entity';
import { UsersService } from '@app/modules/domain/users/users.service';
import type { StringValue } from 'ms';
import { AuthenticatedUser } from './authenticated-user.interface';
import { UserIdentityProvider } from './identity/user-identity-provider.interface';
import { USER_IDENTITY_PROVIDER } from './identity/user-identity-provider.token';
import { RefreshTokenClaims } from './tokens/token-claims.interface';
import { RefreshTokensRepository } from './tokens/refresh-tokens.repository';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';
const INVALID_REFRESH_TOKEN_MESSAGE = 'Invalid or expired refresh token';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
    @Inject(USER_IDENTITY_PROVIDER)
    private readonly userIdentityProvider: UserIdentityProvider,
    private readonly usersService: UsersService,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: CreateUserDto): Promise<{ user: User } & TokenPair> {
    const user = await this.usersService.create(dto);
    const tokens = await this.issueTokenPair(user.id);

    return { user, ...tokens };
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const authenticatedUser = await this.validateCredentials(email, password);
    return this.issueTokenPair(authenticatedUser.id);
  }

  // Unknown email and wrong password MUST fail identically - never reveal which one it was.
  async validateCredentials(
    email: string,
    password: string,
  ): Promise<AuthenticatedUser> {
    const normalizedEmail = email.trim().toLowerCase();
    const identity =
      await this.userIdentityProvider.findByEmail(normalizedEmail);
    if (!identity) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const passwordMatches = await bcrypt.compare(
      password,
      identity.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    return { id: identity.id, email: identity.email, authMethod: 'jwt' };
  }

  async refreshTokenPair(rawToken: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(rawToken);
    const activeRecord =
      await this.refreshTokensRepository.findActiveByTokenHash(tokenHash);
    if (!activeRecord) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const identity = await this.userIdentityProvider.findById(
      activeRecord.userId,
    );
    if (!identity) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const accessToken = this.signAccessToken(identity.id);
    const refreshToken = this.signRefreshToken(identity.id);
    const expiresAt = this.decodeExpiry(refreshToken);

    await this.db.transaction().execute(async (trx) => {
      await this.refreshTokensRepository.revoke(activeRecord.id, trx);
      await this.refreshTokensRepository.create(
        {
          id: randomUUID(),
          userId: identity.id,
          tokenHash: this.hashToken(refreshToken),
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        trx,
      );
    });

    this.logger.log(`Refresh token rotated for user: ${identity.id}`);
    return { accessToken, refreshToken };
  }

  private async issueTokenPair(userId: string): Promise<TokenPair> {
    const accessToken = this.signAccessToken(userId);
    const refreshToken = this.signRefreshToken(userId);
    const expiresAt = this.decodeExpiry(refreshToken);

    await this.refreshTokensRepository.create({
      id: randomUUID(),
      userId,
      tokenHash: this.hashToken(refreshToken),
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { accessToken, refreshToken };
  }

  private signAccessToken(userId: string): string {
    const authConfig = this.configService.getOrThrow<AuthConfig>('auth');

    return this.jwtService.sign(
      { sub: userId, type: 'access', jti: randomUUID() },
      {
        secret: authConfig.accessTokenSecret,
        // envalid validates this comes from config as a duration string (e.g. "15m");
        // jsonwebtoken's types brand that shape as StringValue instead of plain string.
        expiresIn: authConfig.accessTokenTtl as StringValue,
        issuer: authConfig.issuer,
        audience: authConfig.audience,
        algorithm: authConfig.algorithm,
      },
    );
  }

  private signRefreshToken(userId: string): string {
    const authConfig = this.configService.getOrThrow<AuthConfig>('auth');

    return this.jwtService.sign(
      { sub: userId, type: 'refresh', jti: randomUUID() },
      {
        secret: authConfig.refreshTokenSecret,
        expiresIn: authConfig.refreshTokenTtl as StringValue,
        issuer: authConfig.issuer,
        audience: authConfig.audience,
        algorithm: authConfig.algorithm,
      },
    );
  }

  // Reuses the JWT's own exp claim as the DB record's expiresAt, so the two can never drift.
  private decodeExpiry(token: string): Date {
    const decoded = this.jwtService.decode<RefreshTokenClaims>(token);
    return new Date(decoded.exp * 1000);
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
