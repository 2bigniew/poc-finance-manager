import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  Provider,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_CONNECTION } from './database.constants';
import { createKysely } from './kysely.provider';
import { Database } from './types/database.interface';

const kyselyProvider: Provider = {
  provide: KYSELY_CONNECTION,
  useFactory: (): Kysely<Database> => createKysely(),
};

@Global()
@Module({
  providers: [kyselyProvider],
  exports: [KYSELY_CONNECTION],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
