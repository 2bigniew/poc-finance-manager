import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxConfig } from '@config/outbox.config';
import { BrokerKafkaService } from '@app/modules/broker-kafka/broker-kafka.service';
import { OutboxRecord, OutboxRepository } from './outbox.repository';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Connects committed outbox rows to Kafka (CLAUDE.md "OutboxPublisherService"):
//
//   unpublished outbox row -> BrokerKafkaService.produce() -> Kafka ACK -> publishedAt
//
// Delivery is at-least-once, NEVER exactly-once (INFRASTRUCTURE.md "Transactional
// Outbox"): a crash/DB failure between a successful Kafka ACK and the publishedAt write
// leaves the row unpublished, so a future poll republishes the same eventId. Downstream
// consumers are the correctness mechanism for that duplicate window, not this class.
//
// Single-instance assumption (CLAUDE.md "Multiple Application Instances"): polling here
// has no cross-instance claim/lease. Running more than one application instance would
// have every instance race to read/publish the same unpublished rows - harmless (Kafka
// delivery is already at-least-once and idempotent downstream), but NOT throughput-
// efficient. This is an accepted POC trade-off, not a proof of multi-instance
// correctness; a real multi-worker deployment would need an explicit claim/lease column
// (a schema change) rather than hidden repository locking.
@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  private stopped = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private currentPoll: Promise<void> | null = null;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly brokerKafkaService: BrokerKafkaService,
    configService: ConfigService,
  ) {
    const outboxConfig = configService.getOrThrow<OutboxConfig>('outbox');
    this.batchSize = outboxConfig.batchSize;
    this.pollIntervalMs = outboxConfig.pollIntervalMs;
  }

  // Starts polling once every module has finished initializing (same lifecycle hook
  // KafkaConsumerService uses to start Kafka consumers), so BrokerKafkaService's
  // producer is already connected by the time the first poll runs.
  onApplicationBootstrap(): void {
    this.scheduleNextPoll(0);
  }

  // Stops requesting new batches and lets the in-flight one finish (CLAUDE.md
  // "Publisher Lifecycle") rather than aborting mid-batch.
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.currentPoll) {
      await this.currentPoll;
    }
  }

  // Recursive setTimeout, not setInterval: the next poll is only scheduled once the
  // current one has fully settled, so overlapping polls (CLAUDE.md "Polling") are
  // structurally impossible rather than merely unlikely.
  private scheduleNextPoll(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.currentPoll = this.pollOnce()
        .catch((error) => {
          this.logger.error(
            `Outbox poll cycle failed: ${toErrorMessage(error)}`,
          );
        })
        .finally(() => {
          this.currentPoll = null;
          this.scheduleNextPoll(this.pollIntervalMs);
        });
    }, delayMs);
  }

  // Exposed as a public method (rather than only reachable through the timer) so tests
  // can drive exactly one poll cycle deterministically instead of waiting on real
  // timers (TESTING.md "no arbitrary sleeps").
  async pollOnce(): Promise<void> {
    const batch = await this.outboxRepository.findUnpublishedBatch(
      this.batchSize,
    );
    if (batch.length === 0) {
      return;
    }

    this.logger.debug(`Publishing ${batch.length} unpublished outbox event(s)`);

    // Same-messageKey ordering (CLAUDE.md "Per-Key Ordering"): once a row for a given
    // key fails to reach "published" in this cycle, every later row sharing that key is
    // left untouched (not attempted) for the rest of this batch - it stays eligible and
    // in its original position for the next poll, which re-reads oldest-first. Rows for
    // a different key are unaffected and keep progressing independently.
    const blockedKeys = new Set<string>();

    for (const record of batch) {
      const key = record.messageKey;
      if (key !== null && blockedKeys.has(key)) {
        this.logger.debug(
          `Skipping outbox row to preserve message-key ordering [outboxId=${record.id} eventId=${record.eventId} messageKey=${key}]`,
        );
        continue;
      }

      const published = await this.publishOne(record);
      if (!published && key !== null) {
        blockedKeys.add(key);
      }
    }
  }

  private async publishOne(record: OutboxRecord): Promise<boolean> {
    const context = `outboxId=${record.id} eventId=${record.eventId} eventType=${record.eventType} topic=${record.topic} messageKey=${record.messageKey ?? 'null'}`;

    // The outbox row owns routing (CLAUDE.md "Kafka Publication": "The publisher MUST
    // NOT recalculate domain routing") - a missing key is a writer bug, not something
    // this publisher fabricates a fallback for.
    if (!record.messageKey) {
      this.logger.error(
        `Outbox row has no message key, cannot publish (${context})`,
      );
      return false;
    }

    try {
      // Recorded before the attempt, win or lose (CLAUDE.md "Attempt Tracking": one
      // explicit convention, chosen here as "increment before every publication
      // attempt").
      await this.outboxRepository.incrementAttempts(record.id, new Date());
    } catch (error) {
      this.logger.error(
        `Failed to record outbox publish attempt, leaving row for a later poll (${context}): ${toErrorMessage(error)}`,
      );
      return false;
    }

    try {
      // Awaiting produce() to resolve IS the acknowledgement
      // (BrokerKafkaService.produce already waits for the Kafka ACK) - publishedAt is
      // only ever written after this line succeeds (CLAUDE.md "Kafka Acknowledgement").
      await this.brokerKafkaService.produce(record.topic, {
        key: record.messageKey,
        payload: record.payload,
      });
    } catch (error) {
      this.logger.error(
        `Kafka publish failed, row remains unpublished for retry (${context}): ${toErrorMessage(error)}`,
      );
      return false;
    }

    try {
      await this.outboxRepository.markPublished(record.id, new Date());
    } catch (error) {
      // Kafka already has this message. The row stays unpublished and a future poll
      // will publish the SAME eventId again - an intentional, accepted at-least-once
      // duplicate window (CLAUDE.md "Publish Success + DB Update Failure"), not
      // something to paper over by marking the row published in memory only.
      this.logger.error(
        `Kafka publish acknowledged but marking the outbox row published failed - duplicate publication is possible on retry (${context}): ${toErrorMessage(error)}`,
      );
      return false;
    }

    this.logger.log(`Published outbox event (${context})`);
    return true;
  }
}
