import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConsumeBatch } from '../decorators/consume-batch.decorator';
import { ConsumeOneMessage } from '../decorators/consume-one-message.decorator';
import { KafkaHandlerRegistrationError } from '../exceptions/kafka-handler-registration.error';
import { KafkaConsumerDiscoveryService } from './kafka-consumer-discovery.service';

// Proves NestJS discovery/wiring for the developer-facing decorator API (CLAUDE.md
// section 31), not business behavior.
@Injectable()
class TestConsumerService {
  singleCalls: unknown[] = [];
  batchCalls: unknown[] = [];

  @ConsumeOneMessage('test.single')
  async consumeOne(message: unknown): Promise<void> {
    this.singleCalls.push(message);
    await Promise.resolve();
  }

  @ConsumeBatch({ topic: 'test.batch', batchSize: 10 })
  async consumeBatch(messages: unknown[]): Promise<void> {
    this.batchCalls.push(messages);
    await Promise.resolve();
  }
}

@Injectable()
class PlainProviderWithoutHandlers {
  ping(): string {
    return 'pong';
  }
}

async function buildDiscoveryService(
  providers: (new (...args: never[]) => unknown)[],
): Promise<{
  discoveryService: KafkaConsumerDiscoveryService;
  instances: unknown[];
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [KafkaConsumerDiscoveryService, ...providers],
  }).compile();

  return {
    discoveryService: moduleRef.get(KafkaConsumerDiscoveryService),
    instances: providers.map((provider) => moduleRef.get(provider)),
  };
}

describe('KafkaConsumerDiscoveryService', () => {
  it('discovers a @ConsumeOneMessage handler and can invoke it', async () => {
    const { discoveryService, instances } = await buildDiscoveryService([
      TestConsumerService,
    ]);
    const testConsumer = instances[0] as TestConsumerService;

    const registrations = discoveryService.discover();
    const single = registrations.find(
      (registration) => registration.kind === 'single',
    );

    expect(single).toMatchObject({
      kind: 'single',
      topic: 'test.single',
      providerName: 'TestConsumerService',
      methodName: 'consumeOne',
    });

    await single?.invoke({ payload: 1 } as never);
    expect(testConsumer.singleCalls).toEqual([{ payload: 1 }]);
  });

  it('discovers a @ConsumeBatch handler with its configured batchSize and can invoke it', async () => {
    const { discoveryService, instances } = await buildDiscoveryService([
      TestConsumerService,
    ]);
    const testConsumer = instances[0] as TestConsumerService;

    const registrations = discoveryService.discover();
    const batch = registrations.find(
      (registration) => registration.kind === 'batch',
    );

    expect(batch).toMatchObject({
      kind: 'batch',
      topic: 'test.batch',
      batchSize: 10,
      providerName: 'TestConsumerService',
      methodName: 'consumeBatch',
    });

    await batch?.invoke([{ payload: 1 }] as never);
    expect(testConsumer.batchCalls).toEqual([[{ payload: 1 }]]);
  });

  it('ignores providers with no decorated methods', async () => {
    const { discoveryService } = await buildDiscoveryService([
      PlainProviderWithoutHandlers,
    ]);

    expect(discoveryService.discover()).toEqual([]);
  });

  it('throws KafkaHandlerRegistrationError when two providers register the same handler kind for the same topic', async () => {
    @Injectable()
    class DuplicateHandlerService {
      @ConsumeOneMessage('test.single')
      async consumeOne(): Promise<void> {
        await Promise.resolve();
      }
    }

    const { discoveryService } = await buildDiscoveryService([
      TestConsumerService,
      DuplicateHandlerService,
    ]);

    expect(() => discoveryService.discover()).toThrow(
      KafkaHandlerRegistrationError,
    );
  });
});

describe('ConsumeOneMessage', () => {
  it('throws at decoration time when the topic is empty', () => {
    expect(() => {
      class InvalidConsumer {
        @ConsumeOneMessage('')
        async handle(): Promise<void> {
          await Promise.resolve();
        }
      }
      return InvalidConsumer;
    }).toThrow(KafkaHandlerRegistrationError);
  });
});

describe('ConsumeBatch', () => {
  it('throws at decoration time when the topic is empty', () => {
    expect(() => {
      class InvalidConsumer {
        @ConsumeBatch({ topic: '' })
        async handle(): Promise<void> {
          await Promise.resolve();
        }
      }
      return InvalidConsumer;
    }).toThrow(KafkaHandlerRegistrationError);
  });

  it('throws at decoration time when batchSize is not a positive integer', () => {
    expect(() => {
      class InvalidConsumer {
        @ConsumeBatch({ topic: 'test.batch', batchSize: 0 })
        async handle(): Promise<void> {
          await Promise.resolve();
        }
      }
      return InvalidConsumer;
    }).toThrow(KafkaHandlerRegistrationError);
  });
});
