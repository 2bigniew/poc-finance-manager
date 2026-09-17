import type { KafkaMessage as RawKafkaMessage } from 'kafkajs';
import { KafkaMessageParseError } from '../exceptions/kafka-message-parse.error';
import {
  mapKafkaHeaders,
  parseConsumedMessage,
  safeParsePayload,
} from './kafka-message.mapper';

function buildRawMessage(
  overrides: Partial<RawKafkaMessage> = {},
): RawKafkaMessage {
  return {
    key: Buffer.from('reservation-1'),
    value: Buffer.from(JSON.stringify({ amount: 100 })),
    timestamp: '0',
    attributes: 0,
    offset: '42',
    headers: {},
    ...overrides,
  } as RawKafkaMessage;
}

describe('parseConsumedMessage', () => {
  it('parses the JSON payload and preserves topic/partition/offset', () => {
    const message = parseConsumedMessage<{ amount: number }>(
      'reservations.events',
      0,
      buildRawMessage(),
    );

    expect(message).toEqual({
      key: 'reservation-1',
      payload: { amount: 100 },
      topic: 'reservations.events',
      partition: 0,
      offset: '42',
      headers: {},
    });
  });

  it('maps a null key to null', () => {
    const message = parseConsumedMessage(
      'topic',
      0,
      buildRawMessage({ key: null }),
    );

    expect(message.key).toBeNull();
  });

  it('throws KafkaMessageParseError when the value is missing', () => {
    expect(() =>
      parseConsumedMessage('topic', 0, buildRawMessage({ value: null })),
    ).toThrow(KafkaMessageParseError);
  });

  it('throws KafkaMessageParseError when the value is not valid JSON', () => {
    expect(() =>
      parseConsumedMessage(
        'topic',
        0,
        buildRawMessage({ value: Buffer.from('not-json') }),
      ),
    ).toThrow(KafkaMessageParseError);
  });

  it('normalizes string and buffer headers to strings', () => {
    const message = parseConsumedMessage(
      'topic',
      0,
      buildRawMessage({
        headers: {
          correlationId: 'abc-123',
          traceId: Buffer.from('trace-buf'),
        },
      }),
    );

    expect(message.headers).toEqual({
      correlationId: 'abc-123',
      traceId: 'trace-buf',
    });
  });

  it('takes the first value of an array header', () => {
    const message = parseConsumedMessage(
      'topic',
      0,
      buildRawMessage({ headers: { multi: ['first', 'second'] } }),
    );

    expect(message.headers.multi).toBe('first');
  });

  it('maps an undefined header value to undefined', () => {
    const message = parseConsumedMessage(
      'topic',
      0,
      buildRawMessage({ headers: { missing: undefined } }),
    );

    expect(message.headers.missing).toBeUndefined();
  });
});

describe('mapKafkaHeaders', () => {
  it('returns an empty object when headers are undefined', () => {
    expect(mapKafkaHeaders(undefined)).toEqual({});
  });
});

describe('safeParsePayload', () => {
  it('returns null when the value is null', () => {
    expect(safeParsePayload(null)).toBeNull();
  });

  it('parses valid JSON', () => {
    expect(safeParsePayload(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it('falls back to the raw string when JSON parsing fails', () => {
    expect(safeParsePayload(Buffer.from('not-json'))).toBe('not-json');
  });
});
