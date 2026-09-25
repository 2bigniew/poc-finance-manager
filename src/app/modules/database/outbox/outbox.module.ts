import { Module } from '@nestjs/common';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRepository } from './outbox.repository';

// Infrastructure module, not a domain module (CLAUDE.md "Outbox Publisher Location") -
// lives beside DatabaseModule/BrokerKafkaModule, not under domain/. OutboxRepository is
// exported so Reservations/Releases/Reconciliations can write outbox rows inside their
// own business transactions; OutboxPublisherService is never injected anywhere - it only
// needs to exist once in the DI graph so its NestJS lifecycle hooks run (imported by
// each of those same domain modules, the same "imported by multiple modules, one shared
// singleton instance" pattern already used for ProgramsModule).
@Module({
  providers: [OutboxRepository, OutboxPublisherService],
  exports: [OutboxRepository],
})
export class OutboxModule {}
