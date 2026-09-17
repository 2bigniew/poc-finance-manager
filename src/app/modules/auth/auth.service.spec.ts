import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Kysely } from 'kysely';
import { Database } from '@app/modules/database/types/database.interface';
import { User } from '@app/modules/domain/users/user.entity';
import { UsersService } from '@app/modules/domain/users/users.service';
import { AuthService } from './auth.service';
import { RefreshTokenRecord } from './tokens/refresh-token.entity';
import { RefreshTokensRepository } from './tokens/refresh-tokens.repository';

jest.mock('bcrypt');

const bcryptCompare = bcrypt.compare as jest.Mock<
  Promise<boolean>,
  [string, string]
>;

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-id',
    email: 'user@example.test',
    passwordHash: 'stored-hash',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildRefreshTokenRecord(
  overrides: Partial<RefreshTokenRecord> = {},
): RefreshTokenRecord {
  return {
    id: 'refresh-record-id',
    userId: 'user-id',
    tokenHash: 'old-token-hash',
    expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const AUTH_CONFIG = {
  accessTokenSecret: 'access-secret',
  accessTokenTtl: '15m',
  refreshTokenSecret: 'refresh-secret',
  refreshTokenTtl: '7d',
  algorithm: 'HS256' as const,
  issuer: 'poc-finance-manager',
  audience: 'poc-finance-manager-clients',
  bcryptRounds: 4,
};

describe('AuthService', () => {
  let service: AuthService;
  let db: { transaction: jest.Mock };
  let trx: Record<string, never>;
  let userIdentityProvider: { findById: jest.Mock; findByEmail: jest.Mock };
  let usersService: { create: jest.Mock };
  let refreshTokensRepository: {
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>, unknown?]>;
    findActiveByTokenHash: jest.Mock;
    revoke: jest.Mock;
  };
  let jwtService: {
    sign: jest.Mock<
      string,
      [{ sub: string; type: string }, Record<string, unknown>]
    >;
    decode: jest.Mock;
  };
  let configService: { getOrThrow: jest.Mock };

  beforeEach(() => {
    trx = {};
    db = {
      transaction: jest.fn(() => ({
        execute: jest.fn((callback: (executor: unknown) => Promise<unknown>) =>
          callback(trx),
        ),
      })),
    };
    userIdentityProvider = { findById: jest.fn(), findByEmail: jest.fn() };
    usersService = { create: jest.fn() };
    refreshTokensRepository = {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>, unknown?]>(),
      findActiveByTokenHash: jest.fn(),
      revoke: jest.fn(),
    };
    jwtService = {
      sign: jest.fn<
        string,
        [{ sub: string; type: string }, Record<string, unknown>]
      >(),
      decode: jest.fn(),
    };
    configService = { getOrThrow: jest.fn().mockReturnValue(AUTH_CONFIG) };

    bcryptCompare.mockReset();

    let signCallCount = 0;
    jwtService.sign.mockImplementation((payload: { type: string }) => {
      signCallCount += 1;
      return `${payload.type}-token-${signCallCount}`;
    });
    jwtService.decode.mockReturnValue({
      exp: Math.floor(Date.now() / 1000) + 604_800,
    });

    service = new AuthService(
      db as unknown as Kysely<Database>,
      userIdentityProvider,
      usersService as unknown as UsersService,
      refreshTokensRepository as unknown as RefreshTokensRepository,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
  });

  describe('validateCredentials', () => {
    it('returns an AuthenticatedUser for a valid email/password', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      bcryptCompare.mockResolvedValue(true);

      const result = await service.validateCredentials(
        'user@example.test',
        'correct-password',
      );

      expect(result).toEqual({
        id: 'user-id',
        email: 'user@example.test',
        authMethod: 'jwt',
      });
    });

    it('normalizes the email before lookup', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      bcryptCompare.mockResolvedValue(true);

      await service.validateCredentials(
        '  USER@Example.TEST  ',
        'correct-password',
      );

      expect(userIdentityProvider.findByEmail).toHaveBeenCalledWith(
        'user@example.test',
      );
    });

    it('rejects an unknown email', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue(null);

      await expect(
        service.validateCredentials('missing@example.test', 'whatever'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(bcryptCompare).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with the same failure as an unknown email', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      bcryptCompare.mockResolvedValue(false);

      const unknownEmailError = await service
        .validateCredentials('missing@example.test', 'whatever')
        .catch((error: UnauthorizedException) => error);
      const wrongPasswordError = await service
        .validateCredentials('user@example.test', 'wrong-password')
        .catch((error: UnauthorizedException) => error);

      expect((unknownEmailError as UnauthorizedException).message).toBe(
        (wrongPasswordError as UnauthorizedException).message,
      );
    });
  });

  describe('token issuance', () => {
    beforeEach(() => {
      refreshTokensRepository.create.mockResolvedValue(
        buildRefreshTokenRecord(),
      );
    });

    it('signs the access token with type=access and the access secret/issuer/audience', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      bcryptCompare.mockResolvedValue(true);
      await service.login('user@example.test', 'password');

      const accessCall = jwtService.sign.mock.calls.find(
        ([payload]) => payload.type === 'access',
      );
      expect(accessCall?.[0]).toMatchObject({ type: 'access', sub: 'user-id' });
      expect(accessCall?.[1]).toMatchObject({
        secret: AUTH_CONFIG.accessTokenSecret,
        issuer: AUTH_CONFIG.issuer,
        audience: AUTH_CONFIG.audience,
        algorithm: AUTH_CONFIG.algorithm,
      });
    });

    it('signs the refresh token with type=refresh and a different secret than the access token', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      bcryptCompare.mockResolvedValue(true);

      await service.login('user@example.test', 'password');

      const refreshCall = jwtService.sign.mock.calls.find(
        ([payload]) => payload.type === 'refresh',
      );
      expect(refreshCall?.[0]).toMatchObject({
        type: 'refresh',
        sub: 'user-id',
      });
      expect(refreshCall?.[1]).toMatchObject({
        secret: AUTH_CONFIG.refreshTokenSecret,
        issuer: AUTH_CONFIG.issuer,
        audience: AUTH_CONFIG.audience,
      });
      expect(refreshCall?.[1].secret).not.toBe(AUTH_CONFIG.accessTokenSecret);
    });

    it('persists the hashed refresh token, never the raw one', async () => {
      userIdentityProvider.findByEmail.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      bcryptCompare.mockResolvedValue(true);

      const { refreshToken } = await service.login(
        'user@example.test',
        'password',
      );

      const createArg = refreshTokensRepository.create.mock.calls[0]?.[0] as {
        tokenHash: string;
      };
      expect(createArg.tokenHash).not.toBe(refreshToken);
      expect(createArg.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('register', () => {
    it('creates the user via UsersService and issues a token pair', async () => {
      const user = buildUser();
      usersService.create.mockResolvedValue(user);
      refreshTokensRepository.create.mockResolvedValue(
        buildRefreshTokenRecord(),
      );

      const result = await service.register({
        email: user.email,
        password: 'password123',
      });

      expect(usersService.create).toHaveBeenCalledWith({
        email: user.email,
        password: 'password123',
      });
      expect(result.user).toBe(user);
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });
  });

  describe('refreshTokenPair', () => {
    it('rotates a valid refresh token: revokes the old one and issues a new pair', async () => {
      const activeRecord = buildRefreshTokenRecord();
      refreshTokensRepository.findActiveByTokenHash.mockResolvedValue(
        activeRecord,
      );
      userIdentityProvider.findById.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      refreshTokensRepository.create.mockResolvedValue(
        buildRefreshTokenRecord({ id: 'new-record-id' }),
      );

      const result = await service.refreshTokenPair('raw-refresh-token');

      expect(refreshTokensRepository.revoke).toHaveBeenCalledWith(
        activeRecord.id,
        trx,
      );
      expect(refreshTokensRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-id' }),
        trx,
      );
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('rejects when no active record matches the token hash (unknown, revoked, or expired)', async () => {
      refreshTokensRepository.findActiveByTokenHash.mockResolvedValue(null);

      await expect(
        service.refreshTokenPair('unknown-or-revoked-or-expired'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(refreshTokensRepository.revoke).not.toHaveBeenCalled();
    });

    it('rejects when the token resolves to a user that no longer exists', async () => {
      refreshTokensRepository.findActiveByTokenHash.mockResolvedValue(
        buildRefreshTokenRecord(),
      );
      userIdentityProvider.findById.mockResolvedValue(null);

      await expect(
        service.refreshTokenPair('raw-refresh-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(refreshTokensRepository.revoke).not.toHaveBeenCalled();
    });

    it('rejects reuse of an old token after rotation', async () => {
      const activeRecord = buildRefreshTokenRecord();
      refreshTokensRepository.findActiveByTokenHash.mockResolvedValueOnce(
        activeRecord,
      );
      userIdentityProvider.findById.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.test',
        passwordHash: 'stored-hash',
      });
      refreshTokensRepository.create.mockResolvedValue(
        buildRefreshTokenRecord({ id: 'new-record-id' }),
      );

      await service.refreshTokenPair('raw-refresh-token');

      // The old token's row is now revoked, so a second lookup for the same hash finds nothing.
      refreshTokensRepository.findActiveByTokenHash.mockResolvedValueOnce(null);

      await expect(
        service.refreshTokenPair('raw-refresh-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
