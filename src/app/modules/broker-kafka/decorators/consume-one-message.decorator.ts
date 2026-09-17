import { SetMetadata } from '@nestjs/common';
import { KafkaHandlerMetadata, KafkaRetryOptions } from '../broker-kafka.types';
import { KafkaHandlerRegistrationError } from '../exceptions/kafka-handler-registration.error';
import { KAFKA_HANDLER_METADATA } from '../metadata/kafka-handler.metadata';

export interface ConsumeOneMessageOptions {
  topic: string;
  retry?: Partial<KafkaRetryOptions>;
}

// @ConsumeOneMessage('topic-name') or @ConsumeOneMessage({ topic, retry }).
// Registers transport configuration only; KafkaConsumerDiscoveryService discovers and
// wires up decorated methods automatically at startup (ARCHITECTURE.md: "Domain handlers
// MUST NOT manage the raw Kafka consumer lifecycle themselves").
export function ConsumeOneMessage(
  topicOrOptions: string | ConsumeOneMessageOptions,
): MethodDecorator {
  const options: ConsumeOneMessageOptions =
    typeof topicOrOptions === 'string'
      ? { topic: topicOrOptions }
      : topicOrOptions;

  if (!options.topic || options.topic.trim().length === 0) {
    throw new KafkaHandlerRegistrationError(
      '@ConsumeOneMessage requires a non-empty topic name.',
    );
  }

  const metadata: KafkaHandlerMetadata = {
    kind: 'single',
    topic: options.topic,
    retry: options.retry,
  };

  return SetMetadata(KAFKA_HANDLER_METADATA, metadata);
}
