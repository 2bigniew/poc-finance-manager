import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { KafkaConsumedMessage } from './broker-kafka.types';
import {
  bootstrapKafkaTestApp,
  collectMessages,
  createBatchTestConsumer,
  createTestTopics,
  fetchCommittedOffset,
  produceRaw,
  uniqueTopic,
  waitUntil,
} from './test-support/kafka-integration-test.util';

describe('@ConsumeBatch (Kafka integration)', () => {
  const apps: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('discovers the handler, respects the configured batchSize, and keeps records ordered within a partition', async () => {
    const topic = uniqueTopic('batch-size');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    const chunkSizes: number[] = [];
    const seenAmounts: number[] = [];
    const consumer = createBatchTestConsumer(topic, 2, async (messages) => {
      chunkSizes.push(messages.length);
      for (const message of messages) {
        seenAmounts.push((message.payload as { amount: number }).amount);
      }
      await Promise.resolve();
    });

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(
      topic,
      [0, 1, 2, 3, 4].map((amount) => ({
        key: `k${amount}`,
        value: JSON.stringify({ amount }),
      })),
    );

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '5',
    );

    expect(chunkSizes).toEqual([2, 2, 1]);
    expect(seenAmounts).toEqual([0, 1, 2, 3, 4]);
  });

  it('progresses each partition independently on success', async () => {
    const topic = uniqueTopic('batch-multi-partition');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic, numPartitions: 2 }]);

    const consumer = createBatchTestConsumer(topic, 10, async () => {
      await Promise.resolve();
    });

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'p0-a', value: JSON.stringify({ amount: 0 }), partition: 0 },
      { key: 'p0-b', value: JSON.stringify({ amount: 1 }), partition: 0 },
      { key: 'p1-a', value: JSON.stringify({ amount: 2 }), partition: 1 },
      { key: 'p1-b', value: JSON.stringify({ amount: 3 }), partition: 1 },
    ]);

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic, 0)) === '2',
    );
    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic, 1)) === '2',
    );
  });

  // Mirrors CLAUDE.md's canonical example: partition 0 offsets 0/1 succeed, offset 2
  // fails permanently (its dead-letter publish is also forced to fail so it can never
  // become terminal), so offset 3 must never be processed and the committed position
  // must never advance past offset 1 - while a second, healthy partition keeps
  // progressing on its own.
  it('never commits past a failed offset in one partition while another partition progresses independently', async () => {
    const topic = uniqueTopic('batch-partial-failure');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic, numPartitions: 2 }]);

    const processedKeys: string[] = [];
    const consumer = createBatchTestConsumer(
      topic,
      1,
      async (messages) => {
        const message = messages[0] as
          KafkaConsumedMessage<{ shouldFail?: boolean }> | undefined;
        if (!message) {
          return;
        }
        if (message.payload.shouldFail) {
          throw new Error('permanent failure');
        }
        processedKeys.push(message.key ?? '');
        await Promise.resolve();
      },
      { attempts: 1, delayMs: 10 },
    );

    const app = await bootstrapKafkaTestApp([consumer], {
      consumerGroup,
      deadLetterTopicSuffix: ' invalid dlq suffix!',
    });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'p0-offset0', value: JSON.stringify({}), partition: 0 },
      { key: 'p0-offset1', value: JSON.stringify({}), partition: 0 },
      {
        key: 'p0-offset2-stuck',
        value: JSON.stringify({ shouldFail: true }),
        partition: 0,
      },
      {
        key: 'p0-offset3-never-reached',
        value: JSON.stringify({}),
        partition: 0,
      },
      { key: 'p1-offset0', value: JSON.stringify({}), partition: 1 },
      { key: 'p1-offset1', value: JSON.stringify({}), partition: 1 },
    ]);

    // Partition 1 has no failures, so it should reach the end on its own.
    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic, 1)) === '2',
    );

    // Give partition 0's stuck offset time to be retried/re-attempted a few times.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(await fetchCommittedOffset(consumerGroup, topic, 0)).toBe('2');
    expect(processedKeys).toEqual(
      expect.arrayContaining(['p0-offset0', 'p0-offset1']),
    );
    expect(processedKeys).not.toContain('p0-offset3-never-reached');
  }, 20_000);

  it('retries a failing chunk before eventually succeeding and committing', async () => {
    const topic = uniqueTopic('batch-retry-success');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }]);

    let attempts = 0;
    const consumer = createBatchTestConsumer(
      topic,
      1,
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
      { key: 'k', value: JSON.stringify({ amount: 1 }) },
    ]);

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '1',
    );
    expect(attempts).toBe(3);
  });

  it('dead-letters a chunk whose retries are exhausted, and the partition still progresses past it', async () => {
    const topic = uniqueTopic('batch-dlq');
    const consumerGroup = `test-group-${randomUUID()}`;
    await createTestTopics([{ topic }, { topic: `${topic}.dlq` }]);

    const processed: string[] = [];
    const consumer = createBatchTestConsumer(
      topic,
      1,
      async (messages) => {
        const message = messages[0] as
          KafkaConsumedMessage<{ shouldFail?: boolean }> | undefined;
        if (!message) {
          return;
        }
        if (message.payload.shouldFail) {
          throw new Error('permanent failure');
        }
        processed.push(message.key ?? '');
        await Promise.resolve();
      },
      { attempts: 2, delayMs: 10 },
    );

    const app = await bootstrapKafkaTestApp([consumer], { consumerGroup });
    apps.push(app);

    await produceRaw(topic, [
      { key: 'before', value: JSON.stringify({}) },
      { key: 'stuck', value: JSON.stringify({ shouldFail: true }) },
      { key: 'after', value: JSON.stringify({}) },
    ]);

    await waitUntil(
      async () => (await fetchCommittedOffset(consumerGroup, topic)) === '3',
    );
    expect(processed).toEqual(['before', 'after']);

    const deadLetterMessages = await collectMessages(`${topic}.dlq`, {
      count: 1,
    });
    expect(deadLetterMessages).toHaveLength(1);
    expect(deadLetterMessages[0]?.key).toBe('stuck');
  });
});
