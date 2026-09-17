import type { IHeaders, KafkaMessage as RawKafkaMessage } from 'kafkajs';
import { KafkaConsumedMessage } from '../broker-kafka.types';
import { KafkaMessageParseError } from '../exceptions/kafka-message-parse.error';

// Parses a raw kafkajs message into the normalized KafkaConsumedMessage contract that
// handlers receive. A missing value or invalid JSON throws KafkaMessageParseError, which
// the consumer runner treats as an ordinary processing failure subject to retry/DLQ
// (CLAUDE.md section 23: "Malformed JSON MUST fail processing").
export function parseConsumedMessage<TPayload>(
  topic: string,
  partition: number,
  message: RawKafkaMessage,
): KafkaConsumedMessage<TPayload> {
  return {
    key: message.key ? message.key.toString('utf8') : null,
    payload: parseJsonPayload<TPayload>(
      topic,
      partition,
      message.offset,
      message.value,
    ),
    topic,
    partition,
    offset: message.offset,
    headers: mapKafkaHeaders(message.headers),
  };
}

// Reused by the consumer runner to build dead-letter envelopes from the same raw message.
export function safeParsePayload(value: Buffer | null): unknown {
  if (value === null) {
    return null;
  }

  const raw = value.toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function mapKafkaHeaders(
  headers: IHeaders | undefined,
): Record<string, string | undefined> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = normalizeHeaderValue(value);
  }
  return normalized;
}

function parseJsonPayload<TPayload>(
  topic: string,
  partition: number,
  offset: string,
  value: Buffer | null,
): TPayload {
  if (value === null) {
    throw new KafkaMessageParseError(
      `Kafka message has no value (topic "${topic}", partition ${partition}, offset ${offset}).`,
    );
  }

  try {
    return JSON.parse(value.toString('utf8')) as TPayload;
  } catch (error) {
    throw new KafkaMessageParseError(
      `Kafka message value is not valid JSON (topic "${topic}", partition ${partition}, offset ${offset}).`,
      { cause: error },
    );
  }
}

function normalizeHeaderValue(
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) {
    return undefined;
  }

  return Buffer.isBuffer(first) ? first.toString('utf8') : first;
}
