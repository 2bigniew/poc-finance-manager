import { Money } from '@app/modules/domain/shared/money/money';

// Narrow port ProgramsService's capacity-summary read path depends on, without
// ProgramsModule importing ReservationsModule directly.
//
// Why a port instead of a direct import: ReservationsModule naturally depends on
// ProgramsModule (to lock the Program row for capacity-changing writes -
// programs.repository.ts findByIdForUpdate). If ProgramsModule also imported
// ReservationsModule (to read the active-reservation sum for display), the two modules
// would import each other, and CLAUDE.md forbids both that circular dependency and using
// forwardRef() to paper over it. The concrete binding is provided by
// ReservedCapacityPortModule (see reservations/reserved-capacity-port.module.ts), which
// is the only part of this relationship marked @Global() - narrowly, for just this one
// token - so ProgramsModule never needs ReservationsModule in its own `imports`.
export interface ReservedCapacityPort {
  sumActiveByProgram(programId: string): Promise<Money>;
}

export const RESERVED_CAPACITY_PORT = 'RESERVED_CAPACITY_PORT';
