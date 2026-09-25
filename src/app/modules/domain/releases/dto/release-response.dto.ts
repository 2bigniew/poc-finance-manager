import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { FxConversionDto } from '@app/modules/domain/shared/money/dto/fx-conversion.dto';
import { MoneyDto } from '@app/modules/domain/shared/money/dto/money.dto';
import { Money } from '@app/modules/domain/shared/money/money';
import { Release } from '../release.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process - same convention as ReservationResponseDto/InvoiceResponseDto. `conversion`
// only exposes rate/rateDate/source - `original`/`converted` are omitted since they
// would just duplicate originalMoney/convertedMoneyUsd already returned at the top
// level.
@Exclude()
export class ReleaseResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440004',
  })
  @Expose()
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440002',
  })
  @Expose()
  reservationId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @Expose()
  invoiceId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  @Expose()
  programId: string;

  @ApiProperty({
    type: () => MoneyDto,
    description: "Copied exactly from the Reservation's originalMoney.",
    example: { amount: '100.0000', currency: 'EUR' },
  })
  @Expose()
  originalMoney: Money;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      "USD capacity restored to the Program: exactly the Reservation's stored convertedMoneyUsd (no new FX conversion).",
    example: { amount: '113.9400', currency: 'USD' },
  })
  @Expose()
  convertedMoneyUsd: Money;

  @ApiProperty({
    type: () => FxConversionDto,
    description:
      "The Reservation's FX snapshot, reused unchanged (not the current rate).",
  })
  @Expose()
  conversion: FxConversionDto;

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
    example: '2026-09-25T13:17:00.000Z',
  })
  @Expose()
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:17:00.000Z',
  })
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
