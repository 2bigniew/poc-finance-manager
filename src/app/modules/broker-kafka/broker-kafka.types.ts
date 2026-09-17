// Public contract for producing messages - domain services depend only on this, never on
// kafkajs types directly (ARCHITECTURE.md: "Do not leak the underlying Kafka client type
// into domain services").
export interface KafkaProduceMessage<TPayload> {
  key: string;
  payload: TPayload;
  headers?: Record<string, string>;
}

// Normalized shape handed to every @ConsumeOneMessage/@ConsumeBatch handler. Payload is
// already JSON-parsed; handlers never see raw kafkajs message objects.
export interface KafkaConsumedMessage<TPayload> {
  key: string | null;
  payload: TPayload;
  topic: string;
  partition: number;
  offset: string;
  headers: Record<string, string | undefined>;
}

export interface KafkaRetryOptions {
  attempts: number;
  delayMs: number;
}

export type KafkaHandlerMetadata =
  | { kind: 'single'; topic: string; retry?: Partial<KafkaRetryOptions> }
  | {
      kind: 'batch';
      topic: string;
      batchSize: number;
      retry?: Partial<KafkaRetryOptions>;
    };

interface KafkaHandlerRegistrationBase {
  readonly id: string;
  readonly topic: string;
  readonly retry?: Partial<KafkaRetryOptions>;
  readonly providerName: string;
  readonly methodName: string;
}

export interface KafkaSingleHandlerRegistration extends KafkaHandlerRegistrationBase {
  readonly kind: 'single';
  invoke(message: KafkaConsumedMessage<unknown>): Promise<void>;
}

export interface KafkaBatchHandlerRegistration extends KafkaHandlerRegistrationBase {
  readonly kind: 'batch';
  readonly batchSize: number;
  invoke(messages: KafkaConsumedMessage<unknown>[]): Promise<void>;
}

export type KafkaHandlerRegistration =
  KafkaSingleHandlerRegistration | KafkaBatchHandlerRegistration;

// Diagnostic envelope published to <topic><deadLetterTopicSuffix> once retries are
// exhausted (CLAUDE.md section 16: "Preserve enough metadata for diagnosis").
export interface KafkaDeadLetterEnvelope {
  originalTopic: string;
  partition: number;
  offset: string;
  key: string | null;
  payload: unknown;
  headers: Record<string, string | undefined>;
  error: { name: string; message: string };
  attempts: number;
  failedAt: string;
}
