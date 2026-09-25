import { Exclude, Expose } from 'class-transformer';
import { Money } from '@app/modules/domain/shared/money/money';
import { Reservation, ReservationStatus } from '../reservation.entity';

interface ConversionSummary {
  rate: string;
  rateDate: Date;
  source: string;
}

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process. `conversion` only exposes rate/rateDate/source - `original`/`converted` are
// omitted since they would just duplicate originalMoney/convertedMoneyUsd already
// returned at the top level (same convention as InvoiceResponseDto).
@Exclude()
export class ReservationResponseDto {
  @Expose()
  id: string;

  @Expose()
  programId: string;

  @Expose()
  invoiceId: string;

  @Expose()
  originalMoney: Money;

  @Expose()
  convertedMoneyUsd: Money;

  @Expose()
  conversion: ConversionSummary;

  @Expose()
  status: ReservationStatus;

  @Expose()
  createdByUserId: string;

  @Expose()
  createdAt: Date;

  @Expose()
  updatedAt: Date;

  constructor(reservation: Reservation) {
    this.id = reservation.id;
    this.programId = reservation.programId;
    this.invoiceId = reservation.invoiceId;
    this.originalMoney = reservation.originalMoney;
    this.convertedMoneyUsd = reservation.convertedMoneyUsd;
    this.conversion = {
      rate: reservation.conversion.rate,
      rateDate: reservation.conversion.rateDate,
      source: reservation.conversion.source,
    };
    this.status = reservation.status;
    this.createdByUserId = reservation.createdByUserId;
    this.createdAt = reservation.createdAt;
    this.updatedAt = reservation.updatedAt;
  }
}
