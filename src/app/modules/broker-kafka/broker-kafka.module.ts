import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Kafka, Producer } from 'kafkajs';
import { KafkaConfig } from '@config/kafka.config';
import { KAFKA_CLIENT, KAFKA_PRODUCER } from './broker-kafka.constants';
import { BrokerKafkaService } from './broker-kafka.service';
import { KafkaConsumerDiscoveryService } from './consumer/kafka-consumer-discovery.service';
import { KafkaConsumerRunnerService } from './consumer/kafka-consumer-runner.service';
import { KafkaConsumerService } from './consumer/kafka-consumer.service';
import { KafkaRetryService } from './consumer/kafka-retry.service';
import { KafkaProducerService } from './producer/kafka-producer.service';

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

// Owns the entire Kafka integration surface (ARCHITECTURE.md: "Kafka Broker Module").
// Domain modules only ever depend on the exported BrokerKafkaService and the
// @ConsumeOneMessage/@ConsumeBatch decorators - everything else here (client lifecycle,
// consumer discovery/execution, retry/DLQ policy) is private to this module.
@Module({})
export class BrokerKafkaModule {
  static forRootAsync(): DynamicModule {
    return {
      module: BrokerKafkaModule,
      global: true,
      // DiscoveryModule exports DiscoveryService + MetadataScanner, used by
      // KafkaConsumerDiscoveryService to find @ConsumeOneMessage/@ConsumeBatch handlers
      // across every provider in the application at startup.
      imports: [ConfigModule, DiscoveryModule],
      providers: [
        kafkaClientProvider,
        kafkaProducerProvider,
        KafkaProducerService,
        BrokerKafkaService,
        KafkaRetryService,
        KafkaConsumerDiscoveryService,
        KafkaConsumerRunnerService,
        KafkaConsumerService,
      ],
      exports: [BrokerKafkaService],
    };
  }
}
