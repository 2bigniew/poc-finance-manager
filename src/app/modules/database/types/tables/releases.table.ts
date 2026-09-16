import {
  ConversionSource,
  CurrencyCode,
  DecimalAmount,
  FxRate,
} from '../money.types';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export interface ReleasesTable {
  id: PrimaryUuid;
  reservationId: string;
  invoiceId: string;
  programId: string;
  originalAmount: DecimalAmount;
  originalCurrency: CurrencyCode;
  convertedAmountUsd: DecimalAmount;
  conversionRate: FxRate;
  conversionRateDate: Timestamp;
  conversionSource: ConversionSource;
  createdByUserId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
