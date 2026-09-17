import { Module } from '@nestjs/common';
import { USER_IDENTITY_PROVIDER } from '@app/modules/auth/identity/user-identity-provider.token';
import { UsersController } from './users.controller';
import { UsersIdentityProvider } from './users-identity.provider';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [
    UsersRepository,
    UsersService,
    UsersIdentityProvider,
    { provide: USER_IDENTITY_PROVIDER, useExisting: UsersIdentityProvider },
  ],
  // UsersRepository stays private; Auth depends only on USER_IDENTITY_PROVIDER.
  exports: [UsersService, USER_IDENTITY_PROVIDER],
})
export class UsersModule {}
