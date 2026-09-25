import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import {
  KafkaConsumedMessage,
  KafkaHandlerMetadata,
} from '@app/modules/broker-kafka/broker-kafka.types';
import { KAFKA_HANDLER_METADATA } from '@app/modules/broker-kafka/metadata/kafka-handler.metadata';
import { InvalidReconciliationMessageError } from './exceptions/invalid-reconciliation-message.error';
import {
  ReconciliationsConsumerService,
  TREASURY_RECONCILIATION_TOPIC,
} from './reconciliations.consumer.service';
import { ReconciliationsService } from './reconciliations.service';

function buildMessage(payload: unknown): KafkaConsumedMessage<unknown> {
  return {
    key: 'batch-1',
    payload,
    topic: TREASURY_RECONCILIATION_TOPIC,
    partition: 2,
    offset: '42',
    headers: {},
  };
}

describe('ReconciliationsConsumerService', () => {
  let consumer: ReconciliationsConsumerService;
  let reconciliationsService: { reconcileBulk: jest.Mock };

  beforeEach(() => {
    reconciliationsService = {
      reconcileBulk: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new ReconciliationsConsumerService(
      reconciliationsService as unknown as ReconciliationsService,
    );
  });

  // Decorator wiring proof without needing real Kafka: the discovery mechanics
  // themselves (KafkaConsumerDiscoveryService/KafkaConsumerRunnerService) already have
  // their own dedicated test suite in broker-kafka - this only proves THIS class is
  // correctly decorated for the expected topic (CLAUDE.md Final Review item 1).
  it('is decorated with @ConsumeOneMessage for the treasury.reconciliation topic', () => {
    const reflector = new Reflector();
    // Indexed access (rather than a direct `.consume` property reference) avoids
    // detaching a bound class method - same pattern KafkaConsumerDiscoveryService
    // itself uses to read this metadata off a decorated method.
    const prototype =
      ReconciliationsConsumerService.prototype as unknown as Record<
        string,
        (...args: never[]) => unknown
      >;
    const consumeMethod = prototype.consume;
    if (!consumeMethod) {
      throw new Error(
        'Expected ReconciliationsConsumerService.consume to exist.',
      );
    }
    const metadata = reflector.get<KafkaHandlerMetadata | undefined>(
      KAFKA_HANDLER_METADATA,
      consumeMethod,
    );

    expect(metadata).toEqual({
      kind: 'single',
      topic: 'treasury.reconciliation',
    });
  });

  it('validates and maps the payload, then delegates to reconcileBulk with the envelope context', async () => {
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [
        {
          programId: '11111111-1111-1111-1111-111111111111',
          sourceVersion: 3,
          totalCapacityUsd: '1200.0000',
          effectiveAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    await consumer.consume(message);

    expect(reconciliationsService.reconcileBulk).toHaveBeenCalledWith(
      {
        batchId: 'batch-1',
        entries: [
          {
            batchId: 'batch-1',
            programId: '11111111-1111-1111-1111-111111111111',
            sourceVersion: 3,
            totalCapacityUsd: '1200.0000',
            effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      },
      { topic: TREASURY_RECONCILIATION_TOPIC, partition: 2, offset: '42' },
    );
  });

  it('throws InvalidReconciliationMessageError for a malformed payload without calling the service', async () => {
    const message = buildMessage({ nonsense: true });

    await expect(consumer.consume(message)).rejects.toBeInstanceOf(
      InvalidReconciliationMessageError,
    );
    expect(reconciliationsService.reconcileBulk).not.toHaveBeenCalled();
  });

  it('propagates a reconcileBulk failure (so the Kafka handler retries)', async () => {
    const failure = new Error('one or more entries failed');
    reconciliationsService.reconcileBulk.mockRejectedValue(failure);
    const message = buildMessage({
      batchId: 'batch-1',
      programs: [
        {
          programId: '11111111-1111-1111-1111-111111111111',
          sourceVersion: 1,
          totalCapacityUsd: '100.0000',
          effectiveAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    await expect(consumer.consume(message)).rejects.toBe(failure);
  });
});
