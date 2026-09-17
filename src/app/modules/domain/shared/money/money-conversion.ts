import { Money } from './money';

// Immutable audit snapshot of one FX operation (BUSINESS.md MoneyConversion). Once
// created it is never recomputed - a stored conversion represents the exact provider
// rate snapshot used at the time, not a live/refreshable value.
export interface MoneyConversion {
  readonly original: Money;
  readonly converted: Money; // always USD
  readonly rate: string;
  // Frankfurter returns a date-only value ("YYYY-MM-DD"); represented as a UTC Date
  // here for consistency with every other timestamp in this codebase (createdAt,
  // updatedAt, ...) and because the persisted column is TIMESTAMPTZ
  // (InvoicesTable.conversionRateDate), not a plain date/text column.
  readonly rateDate: Date;
  readonly source: 'frankfurter.dev';
}
