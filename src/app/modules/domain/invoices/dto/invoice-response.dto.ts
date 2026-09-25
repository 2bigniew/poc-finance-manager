import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { FxConversionDto } from '@app/modules/domain/shared/money/dto/fx-conversion.dto';
import { MoneyDto } from '@app/modules/domain/shared/money/dto/money.dto';
import { Money } from '@app/modules/domain/shared/money/money';
import { INVOICE_STATUSES, Invoice, InvoiceStatus } from '../invoice.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process. `conversion` only exposes rate/rateDate/source - `original`/`converted` are
// deliberately omitted here since they would just duplicate originalMoney/
// convertedMoneyUsd already returned at the top level (CLAUDE.md section 30).
@Exclude()
export class InvoiceResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @Expose()
  id: string;

  @ApiProperty({ type: String, example: 'INV-2026-0001' })
  @Expose()
  externalReference: string;

  @ApiProperty({
    type: () => MoneyDto,
    description: 'Invoice amount in its original currency.',
    example: { amount: '100.0000', currency: 'EUR' },
  })
  @Expose()
  originalMoney: Money;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      'USD value converted once at Invoice creation and stored; never revalued.',
    example: { amount: '113.9400', currency: 'USD' },
  })
  @Expose()
  convertedMoneyUsd: Money;

  @ApiProperty({
    type: () => FxConversionDto,
    description:
      'FX snapshot fixed at Invoice creation (rate 1, no provider call, for USD Invoices).',
  })
  @Expose()
  conversion: FxConversionDto;

  @ApiProperty({
    enum: INVOICE_STATUSES,
    enumName: 'InvoiceStatus',
    description:
      'OPEN on creation -> RESERVED when reserved against a Program -> REPAID when that Reservation is released. Changed only by those commands.',
    example: 'OPEN',
  })
  @Expose()
  status: InvoiceStatus;

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
    example: '2026-09-25T13:15:00.000Z',
  })
  @Expose()
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:15:00.000Z',
  })
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
