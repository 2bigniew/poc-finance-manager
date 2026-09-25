import { ConfigService } from '@nestjs/config';
import { BrokerKafkaService } from '@app/modules/broker-kafka/broker-kafka.service';
import { OutboxRecord, OutboxRepository } from './outbox.repository';
import { OutboxPublisherService } from './outbox-publisher.service';

function buildRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: 'outbox-1',
    eventId: 'event-1',
    topic: 'reservations.events',
    messageKey: 'program-1',
    eventType: 'reservation.created',
    payload: { reservationId: 'reservation-1' },
    attempts: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedAt: null,
    ...overrides,
  };
}

describe('OutboxPublisherService', () => {
  let publisher: OutboxPublisherService;
  let outboxRepository: {
    findUnpublishedBatch: jest.Mock;
    incrementAttempts: jest.Mock;
    markPublished: jest.Mock;
  };
  let brokerKafkaService: { produce: jest.Mock };
  let configService: { getOrThrow: jest.Mock };

  beforeEach(() => {
    outboxRepository = {
      findUnpublishedBatch: jest.fn().mockResolvedValue([]),
      incrementAttempts: jest.fn().mockResolvedValue(undefined),
      markPublished: jest.fn().mockResolvedValue(buildRecord()),
    };
    brokerKafkaService = {
      produce: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      getOrThrow: jest
        .fn()
        .mockReturnValue({ batchSize: 25, pollIntervalMs: 1000 }),
    };

    publisher = new OutboxPublisherService(
      outboxRepository as unknown as OutboxRepository,
      brokerKafkaService as unknown as BrokerKafkaService,
      configService as unknown as ConfigService,
    );
  });

  it('reads the configured batch size from ConfigService', () => {
    expect(configService.getOrThrow).toHaveBeenCalledWith('outbox');
  });

  it('does nothing when there are no unpublished rows', async () => {
    await publisher.pollOnce();

    expect(outboxRepository.findUnpublishedBatch).toHaveBeenCalledWith(25);
    expect(brokerKafkaService.produce).not.toHaveBeenCalled();
    expect(outboxRepository.incrementAttempts).not.toHaveBeenCalled();
    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('produces the row using its stored topic/key/payload, then marks it published', async () => {
    const record = buildRecord();
    outboxRepository.findUnpublishedBatch.mockResolvedValue([record]);

    await publisher.pollOnce();

    expect(brokerKafkaService.produce).toHaveBeenCalledWith(
      'reservations.events',
      {
        key: 'program-1',
        payload: record.payload,
      },
    );
    expect(outboxRepository.markPublished).toHaveBeenCalledWith(
      record.id,
      expect.any(Date),
    );
  });

  it('increments attempts before attempting to produce', async () => {
    const record = buildRecord();
    outboxRepository.findUnpublishedBatch.mockResolvedValue([record]);
    const callOrder: string[] = [];
    outboxRepository.incrementAttempts.mockImplementation(() => {
      callOrder.push('incrementAttempts');
      return Promise.resolve();
    });
    brokerKafkaService.produce.mockImplementation(() => {
      callOrder.push('produce');
      return Promise.resolve();
    });

    await publisher.pollOnce();

    expect(callOrder).toEqual(['incrementAttempts', 'produce']);
  });

  it('does not mark the row published when Kafka publication fails', async () => {
    const record = buildRecord();
    outboxRepository.findUnpublishedBatch.mockResolvedValue([record]);
    brokerKafkaService.produce.mockRejectedValue(
      new Error('kafka unavailable'),
    );

    await expect(publisher.pollOnce()).resolves.toBeUndefined();

    expect(outboxRepository.incrementAttempts).toHaveBeenCalledWith(
      record.id,
      expect.any(Date),
    );
    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('does not throw when Kafka publish succeeds but marking published fails (at-least-once duplicate window)', async () => {
    const record = buildRecord();
    outboxRepository.findUnpublishedBatch.mockResolvedValue([record]);
    outboxRepository.markPublished.mockRejectedValue(
      new Error('db unavailable'),
    );

    await expect(publisher.pollOnce()).resolves.toBeUndefined();

    expect(brokerKafkaService.produce).toHaveBeenCalledTimes(1);
  });

  it('reuses the eventId already stored on the row - it never generates a new one', async () => {
    const record = buildRecord({ eventId: 'stable-event-id' });
    outboxRepository.findUnpublishedBatch
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce([record]);
    brokerKafkaService.produce
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);

    await publisher.pollOnce();
    await publisher.pollOnce();

    expect(brokerKafkaService.produce).toHaveBeenCalledTimes(2);
    const [, firstMessage] = brokerKafkaService.produce.mock.calls[0] as [
      string,
      { key: string; payload: unknown },
    ];
    const [, secondMessage] = brokerKafkaService.produce.mock.calls[1] as [
      string,
      { key: string; payload: unknown },
    ];
    expect(firstMessage.payload).toBe(record.payload);
    expect(secondMessage.payload).toBe(record.payload);
  });

  it('does not attempt to publish a row with no message key', async () => {
    const record = buildRecord({ messageKey: null });
    outboxRepository.findUnpublishedBatch.mockResolvedValue([record]);

    await publisher.pollOnce();

    expect(brokerKafkaService.produce).not.toHaveBeenCalled();
    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  describe('same-messageKey ordering within one poll cycle', () => {
    it('skips a later row sharing a messageKey once an earlier row for that key fails', async () => {
      const first = buildRecord({ id: 'outbox-1', eventId: 'event-1' });
      const second = buildRecord({ id: 'outbox-2', eventId: 'event-2' });
      outboxRepository.findUnpublishedBatch.mockResolvedValue([first, second]);
      brokerKafkaService.produce.mockRejectedValue(new Error('kafka down'));

      await publisher.pollOnce();

      expect(brokerKafkaService.produce).toHaveBeenCalledTimes(1);
      expect(brokerKafkaService.produce).toHaveBeenCalledWith(
        'reservations.events',
        expect.objectContaining({ payload: first.payload }),
      );
    });

    it('does not block a row with a different messageKey', async () => {
      const first = buildRecord({
        id: 'outbox-1',
        eventId: 'event-1',
        messageKey: 'program-1',
      });
      const second = buildRecord({
        id: 'outbox-2',
        eventId: 'event-2',
        messageKey: 'program-2',
      });
      outboxRepository.findUnpublishedBatch.mockResolvedValue([first, second]);
      brokerKafkaService.produce.mockImplementation(
        (topic: string, message: { key: string }) =>
          message.key === 'program-1'
            ? Promise.reject(new Error('kafka down'))
            : Promise.resolve(),
      );

      await publisher.pollOnce();

      expect(brokerKafkaService.produce).toHaveBeenCalledTimes(2);
      expect(outboxRepository.markPublished).toHaveBeenCalledTimes(1);
      expect(outboxRepository.markPublished).toHaveBeenCalledWith(
        'outbox-2',
        expect.any(Date),
      );
    });
  });

  describe('lifecycle', () => {
    it('polls once on application bootstrap', async () => {
      jest.useFakeTimers();
      const record = buildRecord();
      outboxRepository.findUnpublishedBatch.mockResolvedValue([record]);

      publisher.onApplicationBootstrap();
      await jest.runOnlyPendingTimersAsync();

      expect(outboxRepository.findUnpublishedBatch).toHaveBeenCalled();
      jest.useRealTimers();
      await publisher.onModuleDestroy();
    });

    it('onModuleDestroy stops scheduling further polls and awaits the in-flight one', async () => {
      const state: { resolvePoll: (() => void) | null } = { resolvePoll: null };
      outboxRepository.findUnpublishedBatch.mockImplementation(
        () =>
          new Promise((resolve) => {
            state.resolvePoll = () => resolve([]);
          }),
      );

      publisher.onApplicationBootstrap();
      // Let the scheduled (0ms) poll actually fire and start - its findUnpublishedBatch
      // call is now in-flight and deliberately unresolved. A real short wait, not a
      // microtask flush, is needed because setTimeout(0) is a macrotask.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const destroyed = publisher.onModuleDestroy();
      expect(state.resolvePoll).not.toBeNull();
      state.resolvePoll?.();

      await expect(destroyed).resolves.toBeUndefined();
      // Exactly one call: destroy must not have let a second poll get scheduled.
      expect(outboxRepository.findUnpublishedBatch).toHaveBeenCalledTimes(1);
    });
  });
});
