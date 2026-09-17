import { SetMetadata } from '@nestjs/common';
import { DEFAULT_CONSUME_BATCH_SIZE } from '../broker-kafka.constants';
import { KafkaHandlerMetadata, KafkaRetryOptions } from '../broker-kafka.types';
import { KafkaHandlerRegistrationError } from '../exceptions/kafka-handler-registration.error';
import { KAFKA_HANDLER_METADATA } from '../metadata/kafka-handler.metadata';

export interface ConsumeBatchOptions {
  topic: string;
  batchSize?: number;
  retry?: Partial<KafkaRetryOptions>;
}

// @ConsumeBatch({ topic: 'topic-name', batchSize: 100 }).
// batchSize defaults to DEFAULT_CONSUME_BATCH_SIZE when omitted (CLAUDE.md section 11:
// "Provide a reasonable validated default if omitted").
export function ConsumeBatch(options: ConsumeBatchOptions): MethodDecorator {
  if (!options.topic || options.topic.trim().length === 0) {
    throw new KafkaHandlerRegistrationError(
      '@ConsumeBatch requires a non-empty topic name.',
    );
  }

  const batchSize = options.batchSize ?? DEFAULT_CONSUME_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new KafkaHandlerRegistrationError(
      `@ConsumeBatch batchSize must be a positive integer (topic "${options.topic}").`,
    );
  }

  const metadata: KafkaHandlerMetadata = {
    kind: 'batch',
    topic: options.topic,
    batchSize,
    retry: options.retry,
  };

  return SetMetadata(KAFKA_HANDLER_METADATA, metadata);
}
