import { Money } from '@app/modules/domain/shared/money/money';
import { MoneyConversion } from '@app/modules/domain/shared/money/money-conversion';

export interface Release {
  id: string;

  reservationId: string;
  invoiceId: string;
  programId: string;

  // Copied EXACTLY from the Reservation that is being released - never recomputed, never
  // read from the Invoice, never re-fetched from Frankfurter (BUSINESS.md: "A Release
  // MUST use the exact monetary values and FX conversion stored on the Reservation").
  originalMoney: Money;
  convertedMoneyUsd: Money;
  conversion: MoneyConversion;

  createdByUserId: string;

  createdAt: Date;
  updatedAt: Date;
}
