import { Money } from '@app/modules/domain/shared/money/money';
import { MoneyConversion } from '@app/modules/domain/shared/money/money-conversion';

// Redefined independently of InvoicesTable's InvoiceStatus (database/types) rather than
// imported from it: domain entities do not depend on persistence types - repositories
// own that mapping direction (ARCHITECTURE.md).
export type InvoiceStatus = 'OPEN' | 'RESERVED' | 'REPAID';

export interface Invoice {
  id: string;
  externalReference: string;

  // Preserved separately per BUSINESS.md even though `conversion` below also carries
  // `original`/`converted` - originalMoney/convertedMoneyUsd are the stable top-level
  // accessors; `conversion` is the full FX audit snapshot (rate/rateDate/source).
  originalMoney: Money;
  convertedMoneyUsd: Money;
  conversion: MoneyConversion;

  status: InvoiceStatus;

  createdByUserId: string;

  createdAt: Date;
  updatedAt: Date;
}
