import { Exclude, Expose } from 'class-transformer';
import { Money } from '@app/modules/domain/shared/money/money';
import { Invoice, InvoiceStatus } from '../invoice.entity';

interface ConversionSummary {
  rate: string;
  rateDate: Date;
  source: string;
}

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process. `conversion` only exposes rate/rateDate/source - `original`/`converted` are
// deliberately omitted here since they would just duplicate originalMoney/
// convertedMoneyUsd already returned at the top level (CLAUDE.md section 30).
@Exclude()
export class InvoiceResponseDto {
  @Expose()
  id: string;

  @Expose()
  externalReference: string;

  @Expose()
  originalMoney: Money;

  @Expose()
  convertedMoneyUsd: Money;

  @Expose()
  conversion: ConversionSummary;

  @Expose()
  status: InvoiceStatus;

  @Expose()
  createdByUserId: string;

  @Expose()
  createdAt: Date;

  @Expose()
  updatedAt: Date;

  constructor(invoice: Invoice) {
    this.id = invoice.id;
    this.externalReference = invoice.externalReference;
    this.originalMoney = invoice.originalMoney;
    this.convertedMoneyUsd = invoice.convertedMoneyUsd;
    this.conversion = {
      rate: invoice.conversion.rate,
      rateDate: invoice.conversion.rateDate,
      source: invoice.conversion.source,
    };
    this.status = invoice.status;
    this.createdByUserId = invoice.createdByUserId;
    this.createdAt = invoice.createdAt;
    this.updatedAt = invoice.updatedAt;
  }
}
