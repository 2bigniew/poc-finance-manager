import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { RefreshTokensRepository } from './refresh-tokens.repository';

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `refresh-token-test-${id}@example.test`,
      passwordHash: 'hashed-password-placeholder',
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

function buildRow(
  userId: string,
  overrides: Partial<{ tokenHash: string; expiresAt: Date }> = {},
) {
  const now = new Date();

  return {
    id: randomUUID(),
    userId,
    tokenHash: overrides.tokenHash ?? `hash-${randomUUID()}`,
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
  };
}

describe('RefreshTokensRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: RefreshTokensRepository;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    repository = new RefreshTokensRepository(db);
    userId = await createTestUser(db);
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('refreshTokens').where('userId', '=', userId).execute();
  });

  it('creates a refresh token record', async () => {
    const row = buildRow(userId);
    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.userId).toBe(userId);
    expect(created.tokenHash).toBe(row.tokenHash);
    expect(created.revokedAt).toBeNull();
  });

  it('finds an active token by hash', async () => {
    const row = buildRow(userId);
    await repository.create(row);

    const found = await repository.findActiveByTokenHash(row.tokenHash);
    expect(found?.id).toBe(row.id);
  });

  it('returns null for an unknown token hash', async () => {
    const found = await repository.findActiveByTokenHash(
      `unknown-${randomUUID()}`,
    );
    expect(found).toBeNull();
  });

  it('returns null for a revoked token', async () => {
    const row = buildRow(userId);
    await repository.create(row);
    await repository.revoke(row.id);

    const found = await repository.findActiveByTokenHash(row.tokenHash);
    expect(found).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const row = buildRow(userId, { expiresAt: new Date(Date.now() - 60_000) });
    await repository.create(row);

    const found = await repository.findActiveByTokenHash(row.tokenHash);
    expect(found).toBeNull();
  });

  it('revoke sets revokedAt and is idempotent', async () => {
    const row = buildRow(userId);
    await repository.create(row);

    await repository.revoke(row.id);
    await repository.revoke(row.id);

    const found = await repository.findActiveByTokenHash(row.tokenHash);
    expect(found).toBeNull();
  });
});
