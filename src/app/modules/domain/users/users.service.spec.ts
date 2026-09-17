import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UserEmailAlreadyExistsError } from './exceptions/user-email-already-exists.error';
import { UserNotFoundError } from './exceptions/user-not-found.error';
import { User } from './user.entity';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

jest.mock('bcrypt');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: {
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    findById: jest.Mock;
    findByEmail: jest.Mock;
    list: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let configService: { getOrThrow: jest.Mock };
  // Cast away bcrypt's overloaded (promise vs. callback) signature: it makes
  // jest.MockedFunction's resolved-value type collapse to `never`.
  const bcryptHash = bcrypt.hash as jest.Mock<
    Promise<string>,
    [string, string | number]
  >;

  beforeEach(() => {
    usersRepository = {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    configService = {
      getOrThrow: jest.fn().mockReturnValue({ bcryptRounds: 4 }),
    };

    bcryptHash.mockReset();
    bcryptHash.mockResolvedValue('hashed-password');

    service = new UsersService(
      usersRepository as unknown as UsersRepository,
      configService as unknown as ConfigService,
    );
  });

  describe('create', () => {
    it('generates a UUID for the new user', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      usersRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      const user = await service.create({
        email: 'user@example.test',
        password: 'password123',
      });

      expect(user.id).toMatch(UUID_PATTERN);
    });

    it('normalizes the email before checking uniqueness and persisting', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      usersRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create({
        email: '  USER@Example.TEST  ',
        password: 'password123',
      });

      expect(usersRepository.findByEmail).toHaveBeenCalledWith(
        'user@example.test',
      );
      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'user@example.test' }),
      );
    });

    it('hashes the password using the configured bcrypt work factor', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      usersRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create({
        email: 'user@example.test',
        password: 'password123',
      });

      expect(bcryptHash).toHaveBeenCalledWith('password123', 4);
    });

    it('never passes the plaintext password to the repository', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      usersRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create({
        email: 'user@example.test',
        password: 'password123',
      });

      const createArg = usersRepository.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(createArg.passwordHash).toBe('hashed-password');
      expect(createArg).not.toHaveProperty('password');
      expect(Object.values(createArg)).not.toContain('password123');
    });

    it('throws UserEmailAlreadyExistsError when the email is already taken', async () => {
      usersRepository.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.create({ email: 'user@example.test', password: 'password123' }),
      ).rejects.toBeInstanceOf(UserEmailAlreadyExistsError);
      expect(usersRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns an existing user', async () => {
      const user = buildUser();
      usersRepository.findById.mockResolvedValue(user);

      await expect(service.get(user.id)).resolves.toBe(user);
    });

    it('throws UserNotFoundError when missing', async () => {
      usersRepository.findById.mockResolvedValue(null);

      await expect(service.get('missing-id')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });
  });

  describe('list', () => {
    it('returns users from the repository', async () => {
      const users = [buildUser()];
      usersRepository.list.mockResolvedValue(users);

      await expect(service.list()).resolves.toBe(users);
    });
  });

  describe('update', () => {
    it('updates an existing user', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      const updated = buildUser({ email: 'new@example.test' });
      usersRepository.update.mockResolvedValue(updated);

      await expect(
        service.update('user-id', { email: 'new@example.test' }),
      ).resolves.toBe(updated);
    });

    it('normalizes the email before checking uniqueness and updating', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      usersRepository.update.mockResolvedValue(buildUser());

      await service.update('user-id', { email: '  New@Example.TEST ' });

      expect(usersRepository.findByEmail).toHaveBeenCalledWith(
        'new@example.test',
      );
      expect(usersRepository.update).toHaveBeenCalledWith(
        'user-id',
        expect.objectContaining({ email: 'new@example.test' }),
      );
    });

    it('throws UserEmailAlreadyExistsError when the email belongs to another user', async () => {
      usersRepository.findByEmail.mockResolvedValue(
        buildUser({ id: 'other-id' }),
      );

      await expect(
        service.update('user-id', { email: 'taken@example.test' }),
      ).rejects.toBeInstanceOf(UserEmailAlreadyExistsError);
      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    it('allows updating to the same email already owned by this user', async () => {
      usersRepository.findByEmail.mockResolvedValue(
        buildUser({ id: 'user-id' }),
      );
      const updated = buildUser();
      usersRepository.update.mockResolvedValue(updated);

      await expect(
        service.update('user-id', { email: 'user@example.test' }),
      ).resolves.toBe(updated);
    });

    it('throws UserNotFoundError when the user does not exist', async () => {
      usersRepository.update.mockResolvedValue(null);

      await expect(service.update('missing-id', {})).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });

    it('sets a fresh updatedAt on every update', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      usersRepository.update.mockResolvedValue(buildUser());

      await service.update('user-id', {});

      expect(usersRepository.update).toHaveBeenCalledWith(
        'user-id',
        expect.objectContaining({
          updatedAt: new Date('2026-06-01T12:00:00.000Z'),
        }),
      );
      jest.useRealTimers();
    });
  });

  describe('delete', () => {
    it('deletes an existing user', async () => {
      usersRepository.delete.mockResolvedValue(true);

      await expect(service.delete('user-id')).resolves.toBeUndefined();
    });

    it('throws UserNotFoundError when missing', async () => {
      usersRepository.delete.mockResolvedValue(false);

      await expect(service.delete('missing-id')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });
  });
});
