import { Kafka, logLevel } from 'kafkajs';
import { sleep } from './wait';

export interface PublishedRecord {
  topic: string;
  partition: number;
  offset: string;
}

// Kafka access for the validation. Publishing needs no consumer group at all. The only
// consumer this class ever creates uses a caller-supplied observer group, which must be
// unique per validation run and must never be the application's consumer group -
// otherwise it would steal messages from the application.
export class KafkaProbe {
  private readonly kafka: Kafka;

  constructor(
    brokers: string[],
    clientId: string,
    private readonly forbiddenGroupIds: string[],
  ) {
    this.kafka = new Kafka({
      clientId,
      brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 3 },
    });
  }

  async listTopics(): Promise<string[]> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      return await admin.listTopics();
    } finally {
      await admin.disconnect();
    }
  }

  async topicPartitionCount(topic: string): Promise<number> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      return metadata.topics[0]?.partitions.length ?? 0;
    } finally {
      await admin.disconnect();
    }
  }

  async publish(
    topic: string,
    key: string,
    value: unknown,
  ): Promise<PublishedRecord> {
    const producer = this.kafka.producer();
    await producer.connect();
    try {
      const [metadata] = await producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(value) }],
      });
      return {
        topic,
        partition: metadata?.partition ?? -1,
        offset: metadata?.baseOffset ?? 'unknown',
      };
    } finally {
      await producer.disconnect();
    }
  }

  // Reads `topic` from the beginning with a fresh, unique observer group and reports
  // how many records contain `needle` (an eventId).
  async countRecordsContaining(
    topic: string,
    needle: string,
    observerGroupId: string,
    timeoutMs: number,
  ): Promise<number> {
    if (this.forbiddenGroupIds.includes(observerGroupId)) {
      throw new Error(
        `Refusing to consume with application consumer group "${observerGroupId}"`,
      );
    }

    const consumer = this.kafka.consumer({ groupId: observerGroupId });
    let matches = 0;
    await consumer.connect();
    try {
      await consumer.subscribe({ topic, fromBeginning: true });
      await consumer.run({
        eachMessage: ({ message }) => {
          if (message.value?.toString('utf8').includes(needle)) {
            matches += 1;
          }
          return Promise.resolve();
        },
      });

      const deadline = Date.now() + timeoutMs;
      while (matches === 0 && Date.now() < deadline) {
        await sleep(500);
      }
      // Short grace period so a duplicate publication right after the first match is
      // also counted.
      await sleep(2_000);
      return matches;
    } finally {
      await consumer.disconnect();
    }
  }
}
