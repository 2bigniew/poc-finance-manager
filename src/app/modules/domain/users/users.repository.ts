import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { UsersTable } from '@app/modules/database/types/tables/users.table';
import { UserEmailAlreadyExistsError } from './exceptions/user-email-already-exists.error';
import { User } from './user.entity';

const UNIQUE_VIOLATION = '23505';

interface CreateUserRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

interface UpdateUserRow {
  email?: string;
  updatedAt: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

@Injectable()
export class UsersRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  async create(
    row: CreateUserRow,
    executor: Kysely<Database> = this.db,
  ): Promise<User> {
    try {
      const inserted = await executor
        .insertInto('users')
        .values(row)
        .returningAll()
        .executeTakeFirstOrThrow();

      return this.toEntity(inserted);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UserEmailAlreadyExistsError(row.email);
      }

      throw error;
    }
  }

  async findById(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<User | null> {
    const row = await executor
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async findByEmail(
    email: string,
    executor: Kysely<Database> = this.db,
  ): Promise<User | null> {
    const row = await executor
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async list(executor: Kysely<Database> = this.db): Promise<User[]> {
    const rows = await executor
      .selectFrom('users')
      .selectAll()
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  async update(
    id: string,
    row: UpdateUserRow,
    executor: Kysely<Database> = this.db,
  ): Promise<User | null> {
    try {
      const updated = await executor
        .updateTable('users')
        .set(row)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      return updated ? this.toEntity(updated) : null;
    } catch (error) {
      if (isUniqueViolation(error) && row.email !== undefined) {
        throw new UserEmailAlreadyExistsError(row.email);
      }

      throw error;
    }
  }

  async delete(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('users')
      .where('id', '=', id)
      .executeTakeFirst();

    return result.numDeletedRows > 0n;
  }

  private toEntity(row: Selectable<UsersTable>): User {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
