import { UserIdentity } from './user-identity.interface';

export interface UserIdentityProvider {
  findById(id: string): Promise<UserIdentity | null>;
  findByEmail(email: string): Promise<UserIdentity | null>;
}
