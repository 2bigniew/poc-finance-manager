import { Injectable, Logger } from '@nestjs/common';
import { KafkaConsumedMessage } from '@app/modules/broker-kafka/broker-kafka.types';
import { ConsumeOneMessage } from '@app/modules/broker-kafka/decorators/consume-one-message.decorator';
import { mapBulkReconciliationMessage } from './reconciliations.message-mapper';
import { ReconciliationsService } from './reconciliations.service';

// One Kafka message IS one bulk reconciliation snapshot for potentially many Programs
// (BUSINESS.md: "A bulk reconciliation is a Kafka message containing authoritative
// capacity snapshots for multiple Programs"), so this is a single-message consumer, not
// a batch one - the "batch" is the `programs[]` array inside one message's payload, not
// multiple physical Kafka messages grouped together.
export const TREASURY_RECONCILIATION_TOPIC = 'treasury.reconciliation';

// Thin transport adapter (CLAUDE.md section 1): owns Kafka payload validation/mapping
// and delegates everything else to ReconciliationsService. No Kysely queries, no
// Program locking, no version decisions, and no manual offset handling here - offset
// commit/retry/dead-letter behavior is entirely owned by the broker-kafka module
// (ARCHITECTURE.md: "Kafka handlers delegate to services"; "Domain handlers MUST NOT
// manage the raw Kafka consumer lifecycle"). The contract is exactly resolve = success,
// throw = failure (CLAUDE.md section 49) - nothing here ever calls commitOffsets/
// resolveOffset/heartbeat directly.
@Injectable()
export class ReconciliationsConsumerService {
  private readonly logger = new Logger(ReconciliationsConsumerService.name);

  constructor(
    private readonly reconciliationsService: ReconciliationsService,
  ) {}

  @ConsumeOneMessage(TREASURY_RECONCILIATION_TOPIC)
  async consume(message: KafkaConsumedMessage<unknown>): Promise<void> {
    const input = mapBulkReconciliationMessage(message);

    this.logger.log(
      `Processing reconciliation batch "${input.batchId}" (${input.entries.length} program entries) [topic=${message.topic} partition=${message.partition} offset=${message.offset}]`,
    );

    await this.reconciliationsService.reconcileBulk(input, {
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
    });
  }
}
