import { Global, Module } from '@nestjs/common';
import { RESERVED_CAPACITY_PORT } from '@app/modules/domain/programs/reserved-capacity.port';
import { ReservationsRepository } from './reservations.repository';

// Narrowly @Global(): binds only RESERVED_CAPACITY_PORT (see
// programs/reserved-capacity.port.ts for why) so ProgramsService's capacity-summary read
// path can use it without ProgramsModule importing ReservationsModule - which would
// create a circular module dependency, since ReservationsModule already imports
// ProgramsModule for Program locking (CLAUDE.md forbids both circular imports and
// forwardRef()).
//
// This registers its own ReservationsRepository instance, independent of the one
// ReservationsModule provides for the reservation-creation flow. ReservationsRepository
// is a stateless Kysely query wrapper (like ProgramsRepository/InvoicesRepository) with
// no state of its own - both instances read through the same singleton
// KYSELY_CONNECTION (DatabaseModule is @Global()), so this is behaviorally identical to
// a single shared instance, without requiring a circular module import or forwardRef()
// to achieve literal instance sharing.
@Global()
@Module({
  providers: [
    ReservationsRepository,
    { provide: RESERVED_CAPACITY_PORT, useExisting: ReservationsRepository },
  ],
  exports: [RESERVED_CAPACITY_PORT],
})
export class ReservedCapacityPortModule {}
