import { Money } from '@app/modules/domain/shared/money/money';

export interface Program {
  id: string;
  name: string;
  // Preserved from the ProgramsTable/BUSINESS.md contract even though the current API
  // only strictly requires totalCapacityUsd - dropping it would silently lose real
  // domain data the schema already stores (programs.table.ts).
  originalCapacity: Money;
  // Currency is always 'USD' (BUSINESS.md: "totalCapacityUsd: Money; // always USD").
  totalCapacityUsd: Money;
  treasuryVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

// Derived, never persisted (BUSINESS.md: reservedCapacityUsd = SUM(active
// Reservation.convertedMoneyUsd); availableCapacityUsd = totalCapacityUsd -
// reservedCapacityUsd). Reservations are not implemented yet (CLAUDE.md Explicit
// Non-Goals), so ProgramsService.getCapacitySummary() currently returns
// reservedCapacityUsd = 0 and availableCapacityUsd = totalCapacityUsd. This is the shape
// that changes to a real query later without touching controllers/DTOs.
export interface ProgramCapacitySummary {
  reservedCapacityUsd: Money;
  availableCapacityUsd: Money;
}
