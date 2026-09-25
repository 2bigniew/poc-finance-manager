import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { MoneyDto } from '@app/modules/domain/shared/money/dto/money.dto';
import { Money } from '@app/modules/domain/shared/money/money';
import { Program, ProgramCapacitySummary } from '../program.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process, even if a future edit adds an internal field to the constructor by mistake.
// Money fields are plain {amount, currency} objects (Money has no exclude/expose
// metadata of its own), so they serialize through untouched - see money.ts.
@Exclude()
export class ProgramResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  @Expose()
  id: string;

  @ApiProperty({ type: String, example: 'Supplier Finance Program 2026' })
  @Expose()
  name: string;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      'Capacity as originally agreed, in its original currency. Reference value only.',
    example: { amount: '1000.0000', currency: 'USD' },
  })
  @Expose()
  originalCapacity: Money;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      'Treasury-owned total capacity in USD. Set at creation, then replaced only by Kafka treasury reconciliation.',
    example: { amount: '1000.0000', currency: 'USD' },
  })
  @Expose()
  totalCapacityUsd: Money;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      "Derived on read: sum of the stored USD amounts of this Program's ACTIVE Reservations. Not a stored balance.",
    example: { amount: '300.0000', currency: 'USD' },
  })
  @Expose()
  reservedCapacityUsd: Money;

  @ApiProperty({
    type: () => MoneyDto,
    description:
      'Derived on read: totalCapacityUsd - reservedCapacityUsd. Not independently mutable.',
    example: { amount: '700.0000', currency: 'USD' },
  })
  @Expose()
  availableCapacityUsd: Money;

  @ApiProperty({
    type: Number,
    format: 'int32',
    minimum: 0,
    description:
      'sourceVersion of the last applied treasury reconciliation snapshot (0 until the first one). Read-only.',
    example: 0,
  })
  @Expose()
  treasuryVersion: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:14:00.000Z',
  })
  @Expose()
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-25T13:14:00.000Z',
  })
  @Expose()
  updatedAt: Date;

  constructor(program: Program, capacitySummary: ProgramCapacitySummary) {
    this.id = program.id;
    this.name = program.name;
    this.originalCapacity = program.originalCapacity;
    this.totalCapacityUsd = program.totalCapacityUsd;
    this.reservedCapacityUsd = capacitySummary.reservedCapacityUsd;
    this.availableCapacityUsd = capacitySummary.availableCapacityUsd;
    this.treasuryVersion = program.treasuryVersion;
    this.createdAt = program.createdAt;
    this.updatedAt = program.updatedAt;
  }
}
