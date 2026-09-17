import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { KafkaConsumedMessage } from './broker-kafka.types';
import {
  bootstrapKafkaTestApp,
  collectMessages,
  createSingleTestConsumer,
  createTestTopics,
  fetchCommittedOffset,
  produceRaw,
  uniqueTopic,
  waitUntil,
} from './test-support/kafka-integration-test.util';

describe('@ConsumeOneMessage (Kafka integration)', () => {
  const apps: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('discovers the handler, delivers the message with JSON parsed and key preserved, and commits the offset on success', async () => {
    const topic = uniqueTopic('single-success');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    const received: KafkaConsumedMessage<unknown>[] = [];
    const consumer = createSingleTestConsumer(topic, async (message) => {
      received.push(message);
      await Promise.resolve();
    });

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'program-1', value: JSON.stringify({ amount: 100 }) },
    ]);

    await waitUntil(() => received.length > 0);

    expect(received[0]).toMatchObject({
      key: 'program-1',
      payload: { amount: 100 },
      topic,
      partition: 0,
    });

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );
  });

  it('retries a failing handler and commits the offset once it eventually succeeds', async () => {
    const topic = uniqueTopic('single-retry-success');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    let attempts = 0;
    const consumer = createSingleTestConsumer(
      topic,
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`simulated failure on attempt ${attempts}`);
        }
        await Promise.resolve();
      },
      { attempts: 5, delayMs: 10 },
    );

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'program-1', value: JSON.stringify({ amount: 1 }) },
    ]);

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );
    expect(attempts).toBe(3);
  });

  it('does not commit the offset when retries are exhausted and dead-lettering also fails, and redelivers the message after a restart', async () => {
    const topic = uniqueTopic('single-redelivery');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    // Give the consumer group a real committed-offset baseline first (a brand new group
    // with fromBeginning:false and no committed offset at all starts from the *latest*
    // position on restart, per plain Kafka semantics - unrelated to this module's own
    // retry/commit logic under test below). This mirrors the realistic case: a consumer
    // group that has been running for a while hits a poison message.
    const warmUpReceived: unknown[] = [];
    const warmUpApp = await bootstrapKafkaTestApp(
      [
        createSingleTestConsumer(topic, async (message) => {
          warmUpReceived.push(message);
          await Promise.resolve();
        }),
      ],
      { consumerGroup },
    );
    await produceRaw(topic, [
      { key: 'warm-up', value: JSON.stringify({ amount: 0 }) },
    ]);
    await waitUntil(() => warmUpReceived.length > 0);
    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );
    await warmUpApp.close();

    // An invalid Kafka topic name (spaces are not permitted) makes the dead-letter
    // publish itself fail deterministically, so the offset is left uncommitted
    // (CLAUDE.md section 16: "If dead-letter publication fails: DO NOT commit the
    // original offset") instead of racing against an in-flight retry loop.
    const failingConsumer = createSingleTestConsumer(
      topic,
      () => {
        throw new Error('permanent failure');
      },
      { attempts: 1, delayMs: 10 },
    );

    const appA = await bootstrapKafkaTestApp([failingConsumer], {
      consumerGroup,
      deadLetterTopicSuffix: ' invalid dlq suffix!',
    });
    apps.push(appA);

    await produceRaw(topic, [
      { key: 'program-1', value: JSON.stringify({ amount: 1 }) },
    ]);

    // Give the single failing attempt + failed DLQ publish time to run to completion
    // inside appA before asserting nothing was committed.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await fetchCommittedOffset(consumerGroup, topic)).toBe('1');

    await appA.close();
    apps.length = 0;

    const received: KafkaConsumedMessage<unknown>[] = [];
    const succeedingConsumer = createSingleTestConsumer(
      topic,
      async (message) => {
        received.push(message);
        await Promise.resolve();
      },
    );

    const appB = await bootstrapKafkaTestApp([succeedingConsumer], {
      consumerGroup,
    });
    apps.push(appB);

    await waitUntil(() => received.length > 0, { timeoutMs: 20_000 });
    expect(received[0]).toMatchObject({
      key: 'program-1',
      payload: { amount: 1 },
    });
  }, 45_000);

  it('sends a permanently failing message to the dead-letter topic and still progresses the original offset', async () => {
    const topic = uniqueTopic('single-dlq');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }, { topic: `${topic}.dlq` }]);

    const consumer = createSingleTestConsumer(
      topic,
      () => {
        throw new Error('permanent failure');
      },
      { attempts: 2, delayMs: 10 },
    );

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'program-1', value: JSON.stringify({ amount: 1 }) },
    ]);

    const deadLetterMessages = await collectMessages(`${topic}.dlq`, {
      count: 1,
    });
    expect(deadLetterMessages).toHaveLength(1);
    const deadLettered = deadLetterMessages[0];
    if (!deadLettered) {
      throw new Error('Expected a dead-lettered message');
    }
    expect(deadLettered.key).toBe('program-1');

    const envelope = JSON.parse(deadLettered.value ?? '{}') as {
      originalTopic: string;
      partition: number;
      offset: string;
      key: string | null;
      payload: unknown;
      attempts: number;
      error: { message: string };
    };
    expect(envelope).toMatchObject({
      originalTopic: topic,
      partition: 0,
      offset: '0',
      key: 'program-1',
      payload: { amount: 1 },
      attempts: 2,
      error: { message: 'permanent failure' },
    });

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );
  });

  it('fails processing on malformed JSON and dead-letters it like any other permanent failure', async () => {
    const topic = uniqueTopic('single-malformed-json');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }, { topic: `${topic}.dlq` }]);

    const consumer = createSingleTestConsumer(
      topic,
      async () => {
        await Promise.resolve();
      },
      { attempts: 1, delayMs: 10 },
    );

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [{ key: 'program-1', value: 'not-json' }]);

    const deadLetterMessages = await collectMessages(`${topic}.dlq`, {
      count: 1,
    });
    expect(deadLetterMessages).toHaveLength(1);
    expect(deadLetterMessages[0]?.key).toBe('program-1');
  });
});
