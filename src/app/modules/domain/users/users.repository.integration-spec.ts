import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { UserEmailAlreadyExistsError } from './exceptions/user-email-already-exists.error';
import { UsersRepository } from './users.repository';

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

function buildUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date();

  return {
    id: randomUUID(),
    email: `user-${randomUUID()}@example.test`,
    passwordHash: 'hashed-password-placeholder',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('UsersRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: UsersRepository;

  beforeAll(() => {
    db = createKysely();
    repository = new UsersRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('users').execute();
  });

  it('creates a user and persists the password hash', async () => {
    const row = buildUserRow();
    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.email).toBe(row.email);
    expect(created.passwordHash).toBe(row.passwordHash);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects creating a second user with the same email', async () => {
    const row = buildUserRow();
    await repository.create(row);

    await expect(
      repository.create(buildUserRow({ email: row.email })),
    ).rejects.toBeInstanceOf(UserEmailAlreadyExistsError);
  });

  it('finds a user by id', async () => {
    const row = buildUserRow();
    await repository.create(row);

    const found = await repository.findById(row.id);
    expect(found?.email).toBe(row.email);
  });

  it('returns null when finding a missing id', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('finds a user by email', async () => {
    const row = buildUserRow();
    await repository.create(row);

    const found = await repository.findByEmail(row.email);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding by a missing email', async () => {
    const found = await repository.findByEmail(
      `missing-${randomUUID()}@example.test`,
    );
    expect(found).toBeNull();
  });

  it('lists users ordered by creation time', async () => {
    const rowA = buildUserRow();
    await repository.create(rowA);
    const rowB = buildUserRow();
    await repository.create(rowB);

    const users = await repository.list();
    const ids = users.map((user) => user.id);
    expect(ids).toEqual(expect.arrayContaining([rowA.id, rowB.id]));
  });

  it('updates a user email and updatedAt', async () => {
    const row = buildUserRow();
    await repository.create(row);

    const newEmail = `updated-${randomUUID()}@example.test`;
    const updatedAt = new Date();
    const updated = await repository.update(row.id, {
      email: newEmail,
      updatedAt,
    });

    expect(updated?.email).toBe(newEmail);
    expect(updated?.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect(updated?.createdAt.getTime()).toBe(row.createdAt.getTime());
  });

  it('returns null when updating a missing user', async () => {
    const updated = await repository.update(randomUUID(), {
      updatedAt: new Date(),
    });
    expect(updated).toBeNull();
  });

  it('deletes a user', async () => {
    const row = buildUserRow();
    await repository.create(row);

    const deleted = await repository.delete(row.id);
    expect(deleted).toBe(true);

    const found = await repository.findById(row.id);
    expect(found).toBeNull();
  });

  it('returns false when deleting a missing user', async () => {
    const deleted = await repository.delete(randomUUID());
    expect(deleted).toBe(false);
  });
});
