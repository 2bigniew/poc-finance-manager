import { Module } from '@nestjs/common';
import { OutboxModule } from '@app/modules/database/outbox/outbox.module';
import { InvoicesModule } from '@app/modules/domain/invoices/invoices.module';
import { ProgramsModule } from '@app/modules/domain/programs/programs.module';
import { CurrencyExchangeModule } from '@app/modules/domain/shared/money/currency-exchange.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

// Only imports ProgramsModule/InvoicesModule/CurrencyExchangeModule/OutboxModule - all
// one-directional dependencies of Reservations (CLAUDE.md section 36). Neither
// ProgramsModule nor InvoicesModule imports this module back (see
// reserved-capacity-port.module.ts for how ProgramsService's capacity-summary read path
// avoids needing to), so there is no circular dependency and no forwardRef() anywhere in
// this relationship.
@Module({
  imports: [
    ProgramsModule,
    InvoicesModule,
    CurrencyExchangeModule,
    OutboxModule,
  ],
  controllers: [ReservationsController],
  providers: [ReservationsRepository, ReservationsService],
  // ReservationsRepository stays private; other modules (e.g. the future Release
  // module) coordinate through ReservationsService (ARCHITECTURE.md).
  exports: [ReservationsService],
})
export class ReservationsModule {}
