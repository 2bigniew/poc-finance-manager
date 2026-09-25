import { Exclude, Expose } from 'class-transformer';
import { Money } from '@app/modules/domain/shared/money/money';
import { Release } from '../release.entity';

interface ConversionSummary {
  rate: string;
  rateDate: Date;
  source: string;
}

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process - same convention as ReservationResponseDto/InvoiceResponseDto. `conversion`
// only exposes rate/rateDate/source - `original`/`converted` are omitted since they
// would just duplicate originalMoney/convertedMoneyUsd already returned at the top
// level.
@Exclude()
export class ReleaseResponseDto {
  @Expose()
  id: string;

  @Expose()
  reservationId: string;

  @Expose()
  invoiceId: string;

  @Expose()
  programId: string;

  @Expose()
  originalMoney: Money;

  @Expose()
  convertedMoneyUsd: Money;

  @Expose()
  conversion: ConversionSummary;

  @Expose()
  createdByUserId: string;

  @Expose()
  createdAt: Date;

  @Expose()
  updatedAt: Date;

  constructor(release: Release) {
    this.id = release.id;
    this.reservationId = release.reservationId;
    this.invoiceId = release.invoiceId;
    this.programId = release.programId;
    this.originalMoney = release.originalMoney;
    this.convertedMoneyUsd = release.convertedMoneyUsd;
    this.conversion = {
      rate: release.conversion.rate,
      rateDate: release.conversion.rateDate,
      source: release.conversion.source,
    };
    this.createdByUserId = release.createdByUserId;
    this.createdAt = release.createdAt;
    this.updatedAt = release.updatedAt;
  }
}
