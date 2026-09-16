import { registerAs } from '@nestjs/config';
import { env } from './env';

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  consumerGroup: string;
}

export default registerAs('kafka', (): KafkaConfig => ({
  brokers: env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0),
  clientId: env.KAFKA_CLIENT_ID,
  consumerGroup: env.KAFKA_CONSUMER_GROUP,
}));
