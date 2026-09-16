import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { KafkaConfig } from '@config/kafka.config';
import { KAFKA_CLIENT, KAFKA_PRODUCER } from './broker-kafka.constants';
import { BrokerKafkaService } from './broker-kafka.service';

const kafkaClientProvider: Provider = {
  provide: KAFKA_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Kafka => {
    const kafkaConfig = configService.getOrThrow<KafkaConfig>('kafka');
    return new Kafka({
      clientId: kafkaConfig.clientId,
      brokers: kafkaConfig.brokers,
    });
  },
};

const kafkaProducerProvider: Provider = {
  provide: KAFKA_PRODUCER,
  inject: [KAFKA_CLIENT],
  useFactory: (kafka: Kafka): Producer => kafka.producer({ idempotent: true }),
};

@Module({})
export class BrokerKafkaModule {
  static forRootAsync(): DynamicModule {
    return {
      module: BrokerKafkaModule,
      global: true,
      imports: [ConfigModule],
      providers: [
        kafkaClientProvider,
        kafkaProducerProvider,
        BrokerKafkaService,
      ],
      exports: [BrokerKafkaService],
    };
  }
}
