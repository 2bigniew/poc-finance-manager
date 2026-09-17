import { Exclude, Expose } from 'class-transformer';
import { Money } from '@app/modules/domain/shared/money/money';
import { Program, ProgramCapacitySummary } from '../program.entity';

// Class-level @Exclude() means only fields explicitly @Expose()d below ever leave this
// process, even if a future edit adds an internal field to the constructor by mistake.
// Money fields are plain {amount, currency} objects (Money has no exclude/expose
// metadata of its own), so they serialize through untouched - see money.ts.
@Exclude()
export class ProgramResponseDto {
  @Expose()
  id: string;

  @Expose()
  name: string;

  @Expose()
  originalCapacity: Money;

  @Expose()
  totalCapacityUsd: Money;

  @Expose()
  reservedCapacityUsd: Money;

  @Expose()
  availableCapacityUsd: Money;

  @Expose()
  treasuryVersion: number;

  @Expose()
  createdAt: Date;

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
