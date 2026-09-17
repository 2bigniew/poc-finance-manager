import { Injectable } from '@nestjs/common';
import { UserIdentity } from '@app/modules/auth/identity/user-identity.interface';
import { UserIdentityProvider } from '@app/modules/auth/identity/user-identity-provider.interface';
import { UsersRepository } from './users.repository';

// Implements Auth's port so AuthModule never needs to see UsersRepository directly
// (SECURITY.md: "Auth MUST NOT access UsersRepository directly").
@Injectable()
export class UsersIdentityProvider implements UserIdentityProvider {
  constructor(private readonly usersRepository: UsersRepository) {}

  async findById(id: string): Promise<UserIdentity | null> {
    const user = await this.usersRepository.findById(id);
    return user
      ? { id: user.id, email: user.email, passwordHash: user.passwordHash }
      : null;
  }

  async findByEmail(email: string): Promise<UserIdentity | null> {
    const user = await this.usersRepository.findByEmail(email);
    return user
      ? { id: user.id, email: user.email, passwordHash: user.passwordHash }
      : null;
  }
}
