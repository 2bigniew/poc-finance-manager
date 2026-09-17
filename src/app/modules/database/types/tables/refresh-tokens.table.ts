import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface RefreshTokensTable {
  id: PrimaryUuid;
  userId: string;
  tokenHash: string;
  expiresAt: Timestamp;
  // Timestamp's selected/insert/update variants are all `Date`, so this is behaviorally
  // identical to the previous `Date | null` - just consistent with every other nullable
  // timestamp column in the schema (e.g. processedAt/publishedAt below).
  revokedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
