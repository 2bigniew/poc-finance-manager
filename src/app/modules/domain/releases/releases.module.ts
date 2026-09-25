import { Module } from '@nestjs/common';
import { OutboxModule } from '@app/modules/database/outbox/outbox.module';
import { InvoicesModule } from '@app/modules/domain/invoices/invoices.module';
import { ProgramsModule } from '@app/modules/domain/programs/programs.module';
import { ReservationsModule } from '@app/modules/domain/reservations/reservations.module';
import { ReleasesController } from './releases.controller';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

// Imports ProgramsModule (Program locking), ReservationsModule (Reservation locking and
// the ACTIVE -> RELEASED transition), InvoicesModule (Invoice locking and the
// RESERVED -> REPAID transition) and OutboxModule (transactional outbox writes) - all
// one-directional dependencies of Releases. None of them import this module back, so
// there is no circular dependency and no forwardRef() anywhere in this relationship
// (CLAUDE.md section 34).
@Module({
  imports: [ProgramsModule, ReservationsModule, InvoicesModule, OutboxModule],
  controllers: [ReleasesController],
  providers: [ReleasesRepository, ReleasesService],
  // ReleasesRepository stays private; other future modules coordinate through
  // ReleasesService (ARCHITECTURE.md).
  exports: [ReleasesService],
})
export class ReleasesModule {}
