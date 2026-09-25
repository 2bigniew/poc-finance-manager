import { KafkaConsumedMessage } from '@app/modules/broker-kafka/broker-kafka.types';
import { InvalidReconciliationMessageError } from './exceptions/invalid-reconciliation-message.error';
import { mapBulkReconciliationMessage } from './reconciliations.message-mapper';

function buildMessage(payload: unknown): KafkaConsumedMessage<unknown> {
  return {
    key: 'batch-1',
    payload,
    topic: 'treasury.reconciliation',
    partition: 0,
    offset: '0',
    headers: {},
  };
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    programId: '11111111-1111-1111-1111-111111111111',
    sourceVersion: 1,
    totalCapacityUsd: '1000.0000',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mapBulkReconciliationMessage', () => {
  it('maps a valid message into a BulkReconciliationInput', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [validEntry()],
    });

    const result = mapBulkReconciliationMessage(message);

    expect(result.batchId).toBe('batch-1');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      batchId: 'batch-1',
      programId: '11111111-1111-1111-1111-111111111111',
      sourceVersion: 1,
      totalCapacityUsd: '1000.0000',
      effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('maps multiple program entries in order', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [
        validEntry({ programId: '11111111-1111-1111-1111-111111111111' }),
        validEntry({ programId: '22222222-2222-2222-2222-222222222222' }),
      ],
    });

    const result = mapBulkReconciliationMessage(message);

    expect(result.entries.map((entry) => entry.programId)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
  });

  it.each([
    ['non-object payload', 'not-an-object'],
    ['null payload', null],
  ])('rejects %s', (_label, payload) => {
    expect(() => mapBulkReconciliationMessage(buildMessage(payload))).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects a missing batchId', () => {
    const message = buildMessage({ programs: [validEntry()] });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects an empty batchId', () => {
    const message = buildMessage({ batchId: '  ', programs: [validEntry()] });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects a missing programs array', () => {
    const message = buildMessage({ batchId: 'batch-1' });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects an empty programs array', () => {
    const message = buildMessage({ batchId: 'batch-1', programs: [] });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects a non-array programs field', () => {
    const message = buildMessage({ batchId: 'batch-1', programs: 'nope' });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects an entry with an invalid programId', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [validEntry({ programId: 'not-a-uuid' })],
    });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it.each([-1, 1.5, '1', null, undefined])(
    'rejects an entry with an invalid sourceVersion %p',
    (sourceVersion) => {
      const message = buildMessage({
        batchId: 'batch-1',
        programs: [validEntry({ sourceVersion })],
      });

      expect(() => mapBulkReconciliationMessage(message)).toThrow(
        InvalidReconciliationMessageError,
      );
    },
  );

  it('accepts sourceVersion 0', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [validEntry({ sourceVersion: 0 })],
    });

    expect(() => mapBulkReconciliationMessage(message)).not.toThrow();
  });

  it.each(['-100', 'abc', '', 100, null])(
    'rejects an entry with an invalid totalCapacityUsd %p',
    (totalCapacityUsd) => {
      const message = buildMessage({
        batchId: 'batch-1',
        programs: [validEntry({ totalCapacityUsd })],
      });

      expect(() => mapBulkReconciliationMessage(message)).toThrow(
        InvalidReconciliationMessageError,
      );
    },
  );

  it('rejects an entry with a missing effectiveAt', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [validEntry({ effectiveAt: undefined })],
    });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects an entry with an unparseable effectiveAt', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [validEntry({ effectiveAt: 'not-a-date' })],
    });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });

  it('rejects a non-object entry', () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: ['not-an-object'],
    });

    expect(() => mapBulkReconciliationMessage(message)).toThrow(
      InvalidReconciliationMessageError,
    );
  });
});
