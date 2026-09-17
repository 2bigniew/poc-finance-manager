import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Message, Producer, RecordMetadata } from 'kafkajs';
import { KAFKA_PRODUCER } from '../broker-kafka.constants';
import { KafkaProduceError } from '../exceptions/kafka-produce.error';

// Owns the raw kafkajs Producer lifecycle/send calls so no other class - inside or
// outside this module - touches the kafkajs client type directly (ARCHITECTURE.md:
// "Kafka clients are owned by BrokerKafkaModule and injected through NestJS").
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);

  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log('Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Kafka producer disconnected');
  }

  async send(topic: string, messages: Message[]): Promise<RecordMetadata[]> {
    try {
      // acks: -1 ("all") is the strongest acknowledgement kafkajs exposes; the producer is
      // also created with idempotent: true (broker-kafka.module.ts), which kafkajs already
      // requires acks=all for (INFRASTRUCTURE.md: "acks = all, enable.idempotence = true").
      return await this.producer.send({ topic, messages, acks: -1 });
    } catch (error) {
      this.logger.error(
        `Kafka produce failed for topic "${topic}": ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new KafkaProduceError(`Failed to produce to topic "${topic}"`, {
        cause: error,
      });
    }
  }
}
