import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

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

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: {
    list: jest.Mock;
    get: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(() => {
    usersService = {
      list: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    controller = new UsersController(usersService as unknown as UsersService);
  });

  it('returns a safe response list from UsersService.list', async () => {
    const users = [
      buildUser(),
      buildUser({ id: 'user-id-2', email: 'other@example.test' }),
    ];
    usersService.list.mockResolvedValue(users);

    const result = await controller.list();

    expect(usersService.list).toHaveBeenCalledWith();
    expect(result).toHaveLength(2);
    for (const dto of result) {
      expect(dto).not.toHaveProperty('passwordHash');
    }
  });

  it('forwards the id param to UsersService.get and returns a safe response', async () => {
    const user = buildUser();
    usersService.get.mockResolvedValue(user);

    const result = await controller.get(user.id);

    expect(usersService.get).toHaveBeenCalledWith(user.id);
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('forwards id and UpdateUserDto to UsersService.update and returns a safe response', async () => {
    const dto: UpdateUserDto = { email: 'updated@example.test' };
    const user = buildUser({ email: 'updated@example.test' });
    usersService.update.mockResolvedValue(user);

    const result = await controller.update(user.id, dto);

    expect(usersService.update).toHaveBeenCalledWith(user.id, dto);
    expect(result.email).toBe('updated@example.test');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('forwards the id param to UsersService.delete', async () => {
    usersService.delete.mockResolvedValue(undefined);

    await controller.delete('user-id');

    expect(usersService.delete).toHaveBeenCalledWith('user-id');
  });
});
