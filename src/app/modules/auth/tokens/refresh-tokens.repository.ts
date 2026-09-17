import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { RefreshTokensTable } from '@app/modules/database/types/tables/refresh-tokens.table';
import { RefreshTokenRecord } from './refresh-token.entity';

interface CreateRefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class RefreshTokensRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  async create(
    row: CreateRefreshTokenRow,
    executor: Kysely<Database> = this.db,
  ): Promise<RefreshTokenRecord> {
    const inserted = await executor
      .insertInto('refreshTokens')
      .values({ ...row, revokedAt: null })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toEntity(inserted);
  }

  // Active = not revoked and not yet expired; anything else must be treated as invalid by the caller.
  async findActiveByTokenHash(
    tokenHash: string,
    executor: Kysely<Database> = this.db,
  ): Promise<RefreshTokenRecord | null> {
    const row = await executor
      .selectFrom('refreshTokens')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async revoke(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<void> {
    await executor
      .updateTable('refreshTokens')
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  private toEntity(row: Selectable<RefreshTokensTable>): RefreshTokenRecord {
    return {
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
