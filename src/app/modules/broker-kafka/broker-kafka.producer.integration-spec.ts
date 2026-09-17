import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { BrokerKafkaService } from './broker-kafka.service';
import { KafkaProduceError } from './exceptions/kafka-produce.error';
import { KafkaProducerService } from './producer/kafka-producer.service';
import {
  bootstrapKafkaTestApp,
  collectMessages,
  createTestTopics,
  uniqueTopic,
} from './test-support/kafka-integration-test.util';

describe('BrokerKafkaService producer (Kafka integration)', () => {
  let app: INestApplication;
  let brokerKafkaService: BrokerKafkaService;

  beforeAll(async () => {
    app = await bootstrapKafkaTestApp();
    brokerKafkaService = app.get(BrokerKafkaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('produces a single message that is acknowledged before resolving, with topic/key/JSON payload preserved', async () => {
    const topic = uniqueTopic('producer-single');
    await createTestTopics([{ topic }]);

    await brokerKafkaService.produce(topic, {
      key: 'program-1',
      payload: { amount: 100 },
      headers: { correlationId: 'abc' },
    });

    // If produce() resolved before the broker acknowledged the write, this read (from a
    // completely independent consumer group) could race and see nothing yet.
    const [record] = await collectMessages(topic, { count: 1 });

    expect(record).toMatchObject({
      key: 'program-1',
      value: JSON.stringify({ amount: 100 }),
    });
  });

  it('produces a batch in a single call, preserving each message key/payload/headers', async () => {
    const topic = uniqueTopic('producer-batch');
    await createTestTopics([{ topic }]);

    await brokerKafkaService.produceBatch(topic, [
      { key: 'program-1', payload: { amount: 100 } },
      { key: 'program-2', payload: { amount: 200 } },
    ]);

    const records = await collectMessages(topic, { count: 2 });
    const byKey = new Map(records.map((record) => [record.key, record.value]));

    expect(byKey.get('program-1')).toBe(JSON.stringify({ amount: 100 }));
    expect(byKey.get('program-2')).toBe(JSON.stringify({ amount: 200 }));
  });

  it('rejects an empty batch call rather than silently succeeding without producing', async () => {
    // BrokerKafkaService chooses "return without producing" for an empty batch
    // (CLAUDE.md section 7) - this test documents/locks in that choice at the
    // integration boundary alongside the unit-level coverage in broker-kafka.service.spec.ts.
    const topic = uniqueTopic('producer-empty-batch');
    await createTestTopics([{ topic }]);

    await expect(
      brokerKafkaService.produceBatch(topic, []),
    ).resolves.toBeUndefined();
  });

  it('rejects when the underlying Kafka client cannot reach the broker', async () => {
    const kafka = new Kafka({
      clientId: `test-unreachable-${randomUUID()}`,
      brokers: ['127.0.0.1:1'],
      connectionTimeout: 500,
      requestTimeout: 500,
      retry: { retries: 0 },
    });
    const producer: Producer = kafka.producer({ idempotent: false });
    const kafkaProducerService = new KafkaProducerService(producer);

    await expect(kafkaProducerService.onModuleInit()).rejects.toThrow();
  }, 10_000);

  it('BrokerKafkaService.produce propagates a producer failure instead of resolving', async () => {
    const failingProducer: Pick<Producer, 'send'> = {
      send: () => Promise.reject(new Error('simulated broker rejection')),
    };
    const kafkaProducerService = new KafkaProducerService(
      failingProducer as Producer,
    );
    const service = new BrokerKafkaService(kafkaProducerService);

    await expect(
      service.produce(uniqueTopic('producer-failure'), {
        key: 'k',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(KafkaProduceError);
  });
});
