import {
  ConversionSource,
  CurrencyCode,
  DecimalAmount,
  FxRate,
} from '../money.types';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export type ReservationStatus = 'ACTIVE' | 'RELEASED';

export interface ReservationsTable {
  id: PrimaryUuid;
  programId: string;
  invoiceId: string;
  originalAmount: DecimalAmount;
  originalCurrency: CurrencyCode;
  convertedAmountUsd: DecimalAmount;
  conversionRate: FxRate;
  conversionRateDate: Timestamp;
  conversionSource: ConversionSource;
  status: ReservationStatus;
  createdByUserId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
