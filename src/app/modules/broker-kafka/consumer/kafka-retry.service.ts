import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaConfig } from '@config/kafka.config';
import { KafkaRetryOptions } from '../broker-kafka.types';

// Pure retry-decision/DLQ-naming logic, kept independent of kafkajs so it stays unit
// testable without real infrastructure (CLAUDE.md section 27).
@Injectable()
export class KafkaRetryService {
  private readonly defaults: KafkaRetryOptions;
  private readonly deadLetterTopicSuffix: string;

  constructor(configService: ConfigService) {
    const kafkaConfig = configService.getOrThrow<KafkaConfig>('kafka');
    this.defaults = {
      attempts: kafkaConfig.retryAttempts,
      delayMs: kafkaConfig.retryDelayMs,
    };
    this.deadLetterTopicSuffix = kafkaConfig.deadLetterTopicSuffix;
  }

  // Per-handler @ConsumeOneMessage/@ConsumeBatch retry options override the configured
  // application default; either side may be partial.
  resolveRetryOptions(
    override?: Partial<KafkaRetryOptions>,
  ): KafkaRetryOptions {
    const attempts = override?.attempts ?? this.defaults.attempts;
    const delayMs = override?.delayMs ?? this.defaults.delayMs;

    return {
      attempts: attempts < 1 ? 1 : attempts,
      delayMs: delayMs < 0 ? 0 : delayMs,
    };
  }

  // Exponential backoff bounded by the configured attempt count - retries are never
  // unbounded (CLAUDE.md section 15: "Do not implement infinite retries").
  computeDelayMs(attempt: number, baseDelayMs: number): number {
    return baseDelayMs * 2 ** (attempt - 1);
  }

  resolveDeadLetterTopic(topic: string): string {
    return `${topic}${this.deadLetterTopicSuffix}`;
  }
}
