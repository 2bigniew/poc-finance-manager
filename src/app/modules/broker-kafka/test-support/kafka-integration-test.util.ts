import { randomUUID } from 'node:crypto';
import { Injectable, INestApplication, Provider, Type } from '@nestjs/common';
import { ConfigFactory, ConfigModule, registerAs } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Kafka } from 'kafkajs';
import { env } from '@config/env';
import { KafkaConfig } from '@config/kafka.config';
import { BrokerKafkaModule } from '../broker-kafka.module';
import { KafkaConsumedMessage, KafkaRetryOptions } from '../broker-kafka.types';
import { ConsumeBatch } from '../decorators/consume-batch.decorator';
import { ConsumeOneMessage } from '../decorators/consume-one-message.decorator';

// Shared support for the real-Kafka integration specs in this module (TESTING.md:
// "Kafka Topic Isolation... Consumer groups MUST also be isolated per test/suite").
// Never imported by application code.

function testBrokers(): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

// Every test module gets its own client id/consumer group/DLQ suffix so parallel test
// files (and re-runs) never see each other's messages or rebalance each other's groups.
export function buildTestKafkaConfig(
  overrides: Partial<KafkaConfig> = {},
): ConfigFactory {
  return registerAs('kafka', (): KafkaConfig => ({
    brokers: testBrokers(),
    clientId: `test-client-${randomUUID()}`,
    consumerGroup: `test-group-${randomUUID()}`,
    retryAttempts: 2,
    retryDelayMs: 20,
    deadLetterTopicSuffix: '.dlq',
    ...overrides,
  }));
}

export function uniqueTopic(prefix: string): string {
  return `test-${prefix}-${randomUUID()}`;
}

export async function createTestTopics(
  topics: { topic: string; numPartitions?: number }[],
): Promise<void> {
  const kafka = new Kafka({
    clientId: `test-admin-${randomUUID()}`,
    brokers: testBrokers(),
  });
  const admin = kafka.admin();
  await admin.connect();

  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: topics.map(({ topic, numPartitions }) => ({
        topic,
        numPartitions: numPartitions ?? 1,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

// Bootstraps a minimal NestJS app wiring only BrokerKafkaModule plus whatever test
// consumer providers the caller passes - never the full AppModule, which would also
// require PostgreSQL/auth wiring unrelated to these Kafka-only specs.
export async function bootstrapKafkaTestApp(
  providers: Provider[] = [],
  overrides: Partial<KafkaConfig> = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [buildTestKafkaConfig(overrides)],
      }),
      BrokerKafkaModule.forRootAsync(),
    ],
    providers,
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

export interface RawProducedMessage {
  key?: string | null;
  value: string | null;
  headers?: Record<string, string>;
  partition?: number;
}

// Bypasses BrokerKafkaService entirely so producer-owned behavior (JSON serialization,
// key validation) is never in the path when a test wants to hand the consumer side a
// deliberately raw/malformed record.
export async function produceRaw(
  topic: string,
  messages: RawProducedMessage[],
): Promise<void> {
  const kafka = new Kafka({
    clientId: `test-raw-producer-${randomUUID()}`,
    brokers: testBrokers(),
  });
  const producer = kafka.producer();
  await producer.connect();

  try {
    await producer.send({ topic, messages });
  } finally {
    await producer.disconnect();
  }
}

export interface ConsumedRecord {
  key: string | null;
  value: string | null;
  partition: number;
  offset: string;
}

// Reads back whatever lands on a topic (e.g. a dead-letter topic) using a disposable
// consumer group, independent of the application's own consumer under test.
export async function collectMessages(
  topic: string,
  options: { count: number; timeoutMs?: number },
): Promise<ConsumedRecord[]> {
  const kafka = new Kafka({
    clientId: `test-collector-${randomUUID()}`,
    brokers: testBrokers(),
  });
  const consumer = kafka.consumer({
    groupId: `test-collector-group-${randomUUID()}`,
  });
  const collected: ConsumedRecord[] = [];

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  void consumer.run({
    eachMessage: async ({ partition, message }) => {
      collected.push({
        key: message.key ? message.key.toString('utf8') : null,
        value: message.value ? message.value.toString('utf8') : null,
        partition,
        offset: message.offset,
      });
      await Promise.resolve();
    },
  });

  try {
    await waitUntil(() => collected.length >= options.count, {
      timeoutMs: options.timeoutMs ?? 15_000,
    });
  } finally {
    await consumer.disconnect();
  }

  return collected;
}

export async function fetchCommittedOffset(
  groupId: string,
  topic: string,
  partition = 0,
): Promise<string | undefined> {
  const kafka = new Kafka({
    clientId: `test-admin-${randomUUID()}`,
    brokers: testBrokers(),
  });
  const admin = kafka.admin();
  await admin.connect();

  try {
    const [topicOffsets] = await admin.fetchOffsets({
      groupId,
      topics: [topic],
    });
    return topicOffsets?.partitions.find(
      (entry) => entry.partition === partition,
    )?.offset;
  } finally {
    await admin.disconnect();
  }
}

// Builds a fresh @Injectable provider class wired to @ConsumeOneMessage(topic) - a new
// class per call, so each test can point a differently-behaving handler at its own
// isolated topic (CLAUDE.md section 31: "prove NestJS discovery/wiring").
export function createSingleTestConsumer(
  topic: string,
  handler: (message: KafkaConsumedMessage<unknown>) => Promise<void>,
  retry?: Partial<KafkaRetryOptions>,
): Type<unknown> {
  @Injectable()
  class GeneratedSingleTestConsumer {
    @ConsumeOneMessage({ topic, retry })
    async handle(message: KafkaConsumedMessage<unknown>): Promise<void> {
      await handler(message);
    }
  }

  return GeneratedSingleTestConsumer;
}

// Batch counterpart of createSingleTestConsumer.
export function createBatchTestConsumer(
  topic: string,
  batchSize: number,
  handler: (messages: KafkaConsumedMessage<unknown>[]) => Promise<void>,
  retry?: Partial<KafkaRetryOptions>,
): Type<unknown> {
  @Injectable()
  class GeneratedBatchTestConsumer {
    @ConsumeBatch({ topic, batchSize, retry })
    async handle(messages: KafkaConsumedMessage<unknown>[]): Promise<void> {
      await handler(messages);
    }
  }

  return GeneratedBatchTestConsumer;
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
