import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  async isPostgresReady(): Promise<boolean> {
    try {
      await sql`select 1`.execute(this.db);
      return true;
    } catch (error) {
      this.logger.error(
        'PostgreSQL readiness check failed',
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }
}
