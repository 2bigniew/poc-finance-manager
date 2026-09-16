import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface UsersTable {
  id: PrimaryUuid;
  email: string;
  passwordHash: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
