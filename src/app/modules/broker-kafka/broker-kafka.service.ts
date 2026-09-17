import { Injectable, Logger } from '@nestjs/common';
import type { Message } from 'kafkajs';
import { KafkaProduceMessage } from './broker-kafka.types';
import { KafkaMessageValidationError } from './exceptions/kafka-message-validation.error';
import { KafkaProducerService } from './producer/kafka-producer.service';

// The only Kafka-publishing surface domain modules may depend on - never inject
// KafkaProducerService or a raw kafkajs Producer directly (ARCHITECTURE.md).
//
// This service is for non-transactional publishing only. A Kafka event that must be
// atomic with a PostgreSQL domain change MUST go through the transactional outbox
// instead (CLAUDE.md section 8) - it MUST NOT call produce()/produceBatch() directly
// inside that transaction.
@Injectable()
export class BrokerKafkaService {
  private readonly logger = new Logger(BrokerKafkaService.name);

  constructor(private readonly kafkaProducerService: KafkaProducerService) {}

  async produce<TPayload>(
    topic: string,
    message: KafkaProduceMessage<TPayload>,
  ): Promise<void> {
    this.assertValidTopic(topic);
    const kafkaMessage = this.toKafkaMessage(topic, message);

    await this.kafkaProducerService.send(topic, [kafkaMessage]);
    this.logger.log(
      `Produced message to topic "${topic}" (key="${message.key}")`,
    );
  }

  async produceBatch<TPayload>(
    topic: string,
    messages: KafkaProduceMessage<TPayload>[],
  ): Promise<void> {
    this.assertValidTopic(topic);

    if (messages.length === 0) {
      this.logger.debug(`Skipped producing an empty batch to topic "${topic}"`);
      return;
    }

    const kafkaMessages = messages.map((message) =>
      this.toKafkaMessage(topic, message),
    );

    // A single send() call with multiple messages is one produce request - the batch
    // primitive kafkajs provides - rather than looping over produce() per message
    // (CLAUDE.md section 7).
    await this.kafkaProducerService.send(topic, kafkaMessages);
    this.logger.log(
      `Produced batch of ${messages.length} message(s) to topic "${topic}"`,
    );
  }

  private assertValidTopic(topic: string): void {
    if (!topic || topic.trim().length === 0) {
      throw new KafkaMessageValidationError(
        'Kafka topic must be a non-empty string.',
      );
    }
  }

  private toKafkaMessage<TPayload>(
    topic: string,
    message: KafkaProduceMessage<TPayload>,
  ): Message {
    if (!message.key || message.key.trim().length === 0) {
      throw new KafkaMessageValidationError(
        `Kafka message key is required (topic "${topic}").`,
      );
    }

    return {
      key: message.key,
      value: JSON.stringify(message.payload) ?? null,
      headers: message.headers,
    };
  }
}
