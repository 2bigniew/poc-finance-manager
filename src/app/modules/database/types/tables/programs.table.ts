import { CurrencyCode, DecimalAmount } from '../money.types';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface ProgramsTable {
  id: PrimaryUuid;
  name: string;
  originalCapacityAmount: DecimalAmount;
  originalCapacityCurrency: CurrencyCode;
  totalCapacityUsdAmount: DecimalAmount;
  treasuryVersion: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
