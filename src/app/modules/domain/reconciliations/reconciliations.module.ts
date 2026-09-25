import { Module } from '@nestjs/common';
import { OutboxModule } from '@app/modules/database/outbox/outbox.module';
import { ProgramsModule } from '@app/modules/domain/programs/programs.module';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';
import { ReconciliationsConsumerService } from './reconciliations.consumer.service';
import { ReconciliationsRepository } from './reconciliations.repository';
import { ReconciliationsService } from './reconciliations.service';

// Imports ProgramsModule for Program locking/treasury-capacity replacement and
// OutboxModule for transactional outbox writes - one-directional dependencies (neither
// imports this module back), so there is no circular dependency and no forwardRef()
// (CLAUDE.md section 34/55: "Do not use forwardRef() to hide a dependency problem"). No
// controller and no exported repository beyond ReconciliationsService: reconciliation
// has no HTTP surface (CLAUDE.md section 54) - ReconciliationsConsumerService is
// discovered and started by the broker-kafka module purely from its
// @ConsumeOneMessage decorator metadata; simply registering it as a provider here is
// sufficient (ARCHITECTURE.md: "Decorators register handlers during NestJS module
// discovery/bootstrap").
@Module({
  imports: [ProgramsModule, OutboxModule],
  providers: [
    ReconciliationsRepository,
    ReconciliationEventsRepository,
    ReconciliationsService,
    ReconciliationsConsumerService,
  ],
  exports: [ReconciliationsService],
})
export class ReconciliationsModule {}
