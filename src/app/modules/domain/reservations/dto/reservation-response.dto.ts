import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { FxConversionDto } from '@app/modules/domain/shared/money/dto/fx-conversion.dto';
import { MoneyDto } from '@app/modules/domain/shared/money/dto/money.dto';
import { Money } from '@app/modules/domain/shared/money/money';
import {
  RESERVATION_STATUSES,
  Reservation,
  ReservationStatus,
} from '../reservation.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process. `conversion` only exposes rate/rateDate/source - `original`/`converted` are
// omitted since they would just duplicate originalMoney/convertedMoneyUsd already
// returned at the top level (same convention as InvoiceResponseDto).
@Exclude()
export class ReservationResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440002',
  })
  @Expose()
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  @Expose()
  programId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @Expose()
  invoiceId: string;

  @ApiProperty({
    type: () => MoneyDto,
    description: "The Invoice's original amount at reservation time.",
    example: { amount: '100.0000', currency: 'EUR' },
  })
  @Expose()
  originalMoney: Money;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      'USD amount consumed from the Program capacity. Stored at reservation time and never revalued; a Release restores exactly this amount.',
    example: { amount: '113.9400', currency: 'USD' },
  })
  @Expose()
  convertedMoneyUsd: Money;

  @ApiProperty({
    type: () => FxConversionDto,
    description:
      "Reservation-time FX snapshot, copied from the Invoice's stored conversion.",
  })
  @Expose()
  conversion: FxConversionDto;

  @ApiProperty({
    enum: RESERVATION_STATUSES,
    enumName: 'ReservationStatus',
    description:
      'ACTIVE while it consumes Program capacity; RELEASED after the release command.',
    example: 'ACTIVE',
  })
  @Expose()
  status: ReservationStatus;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  @Expose()
  createdByUserId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:16:00.000Z',
  })
  @Expose()
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:16:00.000Z',
  })
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
