import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface RefreshTokensTable {
  id: PrimaryUuid;
  userId: string;
  tokenHash: string;
  expiresAt: Timestamp;
  revokedAt: Date | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
