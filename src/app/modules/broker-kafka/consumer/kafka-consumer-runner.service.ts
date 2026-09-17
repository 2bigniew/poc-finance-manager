import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaConfig } from '@config/kafka.config';
import type {
  Consumer,
  EachBatchPayload,
  EachMessagePayload,
  Kafka,
  KafkaMessage as RawKafkaMessage,
} from 'kafkajs';
import { KAFKA_CLIENT } from '../broker-kafka.constants';
import { BrokerKafkaService } from '../broker-kafka.service';
import {
  KafkaBatchHandlerRegistration,
  KafkaDeadLetterEnvelope,
  KafkaHandlerRegistration,
  KafkaProduceMessage,
  KafkaRetryOptions,
  KafkaSingleHandlerRegistration,
} from '../broker-kafka.types';
import {
  chunkMessages,
  computeHighestContiguousOffset,
  OffsetOutcome,
} from './kafka-batch.util';
import { delay } from './delay.util';
import {
  mapKafkaHeaders,
  parseConsumedMessage,
  safeParsePayload,
} from './kafka-message.mapper';
import { KafkaRetryService } from './kafka-retry.service';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

// Owns one kafkajs Consumer per discovered handler and implements the manual
// offset-commit / bounded-retry / dead-letter flow described in CLAUDE.md. Domain
// consumer services never see this class or the underlying kafkajs Consumer
// (ARCHITECTURE.md: "Domain handlers MUST NOT manage the raw Kafka consumer lifecycle
// themselves").
@Injectable()
export class KafkaConsumerRunnerService {
  private readonly logger = new Logger(KafkaConsumerRunnerService.name);
  private readonly consumers = new Map<string, Consumer>();
  private readonly consumerGroup: string;

  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    configService: ConfigService,
    private readonly kafkaRetryService: KafkaRetryService,
    private readonly brokerKafkaService: BrokerKafkaService,
  ) {
    this.consumerGroup =
      configService.getOrThrow<KafkaConfig>('kafka').consumerGroup;
  }

  async start(registration: KafkaHandlerRegistration): Promise<void> {
    const consumer = this.kafka.consumer({ groupId: this.consumerGroup });
    this.consumers.set(registration.id, consumer);

    await consumer.connect();
    await consumer.subscribe({
      topic: registration.topic,
      fromBeginning: false,
    });

    if (registration.kind === 'single') {
      await consumer.run({
        autoCommit: false,
        eachMessage: (payload) =>
          this.handleSingleMessage(consumer, registration, payload),
      });
      return;
    }

    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.handleBatch(consumer, registration, payload),
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.consumers.values()).map((consumer) =>
        consumer.disconnect(),
      ),
    );
    this.consumers.clear();
  }

  private async handleSingleMessage(
    consumer: Consumer,
    registration: KafkaSingleHandlerRegistration,
    payload: EachMessagePayload,
  ): Promise<void> {
    const { topic, partition, message } = payload;
    const retryOptions = this.kafkaRetryService.resolveRetryOptions(
      registration.retry,
    );
    let lastError: unknown;

    for (let attempt = 1; attempt <= retryOptions.attempts; attempt += 1) {
      try {
        const consumedMessage = parseConsumedMessage<unknown>(
          topic,
          partition,
          message,
        );
        await registration.invoke(consumedMessage);
        await this.commitOffset(
          consumer,
          topic,
          partition,
          nextOffset(message.offset),
        );
        return;
      } catch (error) {
        lastError = error;
        this.logRetry(
          registration,
          topic,
          partition,
          message,
          attempt,
          retryOptions.attempts,
          error,
        );
        if (attempt < retryOptions.attempts) {
          await payload.heartbeat();
          await delay(
            this.kafkaRetryService.computeDelayMs(
              attempt,
              retryOptions.delayMs,
            ),
          );
        }
      }
    }

    const publishedToDeadLetter = await this.publishToDeadLetter(
      topic,
      partition,
      message,
      retryOptions.attempts,
      lastError,
    );

    if (publishedToDeadLetter) {
      await this.commitOffset(
        consumer,
        topic,
        partition,
        nextOffset(message.offset),
      );
      return;
    }

    this.logger.error(
      `Kafka message permanently failed and could not be dead-lettered; offset left uncommitted for redelivery [topic=${topic} partition=${partition} offset=${message.offset}]`,
    );
  }

  private async handleBatch(
    consumer: Consumer,
    registration: KafkaBatchHandlerRegistration,
    payload: EachBatchPayload,
  ): Promise<void> {
    const { topic, partition, messages } = payload.batch;
    const retryOptions = this.kafkaRetryService.resolveRetryOptions(
      registration.retry,
    );
    const chunks = chunkMessages(messages, registration.batchSize);
    const outcomes: OffsetOutcome[] = [];

    for (const chunk of chunks) {
      if (!payload.isRunning() || payload.isStale()) {
        break;
      }

      const lastMessageInChunk = chunk[chunk.length - 1];
      if (!lastMessageInChunk) {
        continue;
      }

      const terminal = await this.processBatchChunk(
        registration,
        topic,
        partition,
        chunk,
        retryOptions,
        () => payload.heartbeat(),
      );

      outcomes.push({ offset: lastMessageInChunk.offset, success: terminal });
      if (!terminal) {
        break;
      }

      for (const message of chunk) {
        payload.resolveOffset(message.offset);
      }
    }

    const committableOffset = computeHighestContiguousOffset(outcomes);
    if (committableOffset !== null) {
      await this.commitOffset(
        consumer,
        topic,
        partition,
        nextOffset(committableOffset),
      );
    }
  }

  private async processBatchChunk(
    registration: KafkaBatchHandlerRegistration,
    topic: string,
    partition: number,
    chunk: RawKafkaMessage[],
    retryOptions: KafkaRetryOptions,
    heartbeat: () => Promise<void>,
  ): Promise<boolean> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= retryOptions.attempts; attempt += 1) {
      try {
        const consumedMessages = chunk.map((message) =>
          parseConsumedMessage<unknown>(topic, partition, message),
        );
        await registration.invoke(consumedMessages);
        return true;
      } catch (error) {
        lastError = error;
        this.logRetry(
          registration,
          topic,
          partition,
          chunk[0] ?? null,
          attempt,
          retryOptions.attempts,
          error,
          chunk.length,
        );
        if (attempt < retryOptions.attempts) {
          await heartbeat();
          await delay(
            this.kafkaRetryService.computeDelayMs(
              attempt,
              retryOptions.delayMs,
            ),
          );
        }
      }
    }

    return this.publishChunkToDeadLetter(
      topic,
      partition,
      chunk,
      retryOptions.attempts,
      lastError,
    );
  }

  private async publishToDeadLetter(
    topic: string,
    partition: number,
    message: RawKafkaMessage,
    attempts: number,
    error: unknown,
  ): Promise<boolean> {
    const deadLetterTopic =
      this.kafkaRetryService.resolveDeadLetterTopic(topic);

    try {
      await this.brokerKafkaService.produce(
        deadLetterTopic,
        this.toDeadLetterMessage(topic, partition, message, attempts, error),
      );
      return true;
    } catch (deadLetterError) {
      this.logger.error(
        `Failed to publish dead-letter message for topic "${topic}" partition ${partition} offset ${message.offset}: ${toErrorMessage(deadLetterError)}`,
      );
      return false;
    }
  }

  private async publishChunkToDeadLetter(
    topic: string,
    partition: number,
    chunk: RawKafkaMessage[],
    attempts: number,
    error: unknown,
  ): Promise<boolean> {
    const deadLetterTopic =
      this.kafkaRetryService.resolveDeadLetterTopic(topic);

    try {
      await this.brokerKafkaService.produceBatch(
        deadLetterTopic,
        chunk.map((message) =>
          this.toDeadLetterMessage(topic, partition, message, attempts, error),
        ),
      );
      return true;
    } catch (deadLetterError) {
      this.logger.error(
        `Failed to publish dead-letter batch for topic "${topic}" partition ${partition}: ${toErrorMessage(deadLetterError)}`,
      );
      return false;
    }
  }

  private toDeadLetterMessage(
    topic: string,
    partition: number,
    message: RawKafkaMessage,
    attempts: number,
    error: unknown,
  ): KafkaProduceMessage<KafkaDeadLetterEnvelope> {
    const key = message.key
      ? message.key.toString('utf8')
      : `${topic}:${partition}:${message.offset}`;

    const envelope: KafkaDeadLetterEnvelope = {
      originalTopic: topic,
      partition,
      offset: message.offset,
      key: message.key ? message.key.toString('utf8') : null,
      payload: safeParsePayload(message.value),
      headers: mapKafkaHeaders(message.headers),
      error: { name: toErrorName(error), message: toErrorMessage(error) },
      attempts,
      failedAt: new Date().toISOString(),
    };

    return { key, payload: envelope };
  }

  private async commitOffset(
    consumer: Consumer,
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    await consumer.commitOffsets([{ topic, partition, offset }]);
  }

  private logRetry(
    registration: KafkaHandlerRegistration,
    topic: string,
    partition: number,
    message: RawKafkaMessage | null,
    attempt: number,
    maxAttempts: number,
    error: unknown,
    chunkSize?: number,
  ): void {
    const key = message?.key ? message.key.toString('utf8') : 'null';
    const offset = message?.offset ?? 'n/a';
    const chunkInfo = chunkSize ? ` chunkSize=${chunkSize}` : '';

    this.logger.warn(
      `Kafka handler failed for "${registration.providerName}.${registration.methodName}" [topic=${topic} partition=${partition} offset=${offset} key=${key} attempt=${attempt}/${maxAttempts}${chunkInfo}]: ${toErrorMessage(error)}`,
    );
  }
}
