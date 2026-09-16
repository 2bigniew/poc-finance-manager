import {
  ConversionSource,
  CurrencyCode,
  DecimalAmount,
  FxRate,
} from '../money.types';
import { PrimaryUuid } from '../primary-uuid.type';
import { Timestamp } from '../timestamp.type';

export type InvoiceStatus = 'OPEN' | 'RESERVED' | 'REPAID';

export interface InvoicesTable {
  id: PrimaryUuid;
  externalReference: string;
  originalAmount: DecimalAmount;
  originalCurrency: CurrencyCode;
  convertedAmountUsd: DecimalAmount;
  conversionRate: FxRate;
  conversionRateDate: Timestamp;
  conversionSource: ConversionSource;
  status: InvoiceStatus;
  createdByUserId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
