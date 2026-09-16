import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Producer } from 'kafkajs';
import { KAFKA_PRODUCER } from './broker-kafka.constants';
import { KafkaMessage } from './broker-kafka.interfaces';

@Injectable()
export class BrokerKafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrokerKafkaService.name);

  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log('Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }

  async produce<T>(topic: string, message: KafkaMessage<T>): Promise<void> {
    await this.producer.send({
      topic,
      messages: [
        {
          key: message.key,
          value: JSON.stringify(message.payload),
          headers: message.headers,
        },
      ],
    });
  }
}
