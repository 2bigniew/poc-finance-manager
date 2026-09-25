import { Module } from '@nestjs/common';
import { ReservedCapacityPortModule } from '@app/modules/domain/reservations/reserved-capacity-port.module';
import { ProgramsController } from './programs.controller';
import { ProgramsRepository } from './programs.repository';
import { ProgramsService } from './programs.service';

// ReservedCapacityPortModule is @Global() (binds RESERVED_CAPACITY_PORT only - see
// reserved-capacity.port.ts), so this import is here for documentation/clarity rather
// than strict necessity, and deliberately NOT ReservationsModule itself (see that
// file's own comment for why importing ReservationsModule directly would be circular).
@Module({
  imports: [ReservedCapacityPortModule],
  controllers: [ProgramsController],
  providers: [ProgramsRepository, ProgramsService],
  // ProgramsRepository stays private; other modules coordinate through ProgramsService
  // (ARCHITECTURE.md: cross-module access goes through services, not repositories).
  exports: [ProgramsService],
})
export class ProgramsModule {}
