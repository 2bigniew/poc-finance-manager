import { BrokerKafkaService } from './broker-kafka.service';
import { KafkaMessageValidationError } from './exceptions/kafka-message-validation.error';
import { KafkaProducerService } from './producer/kafka-producer.service';

function buildService(): {
  service: BrokerKafkaService;
  producer: { send: jest.Mock };
} {
  const producer = { send: jest.fn().mockResolvedValue([]) };
  const service = new BrokerKafkaService(
    producer as unknown as KafkaProducerService,
  );
  return { service, producer };
}

describe('BrokerKafkaService', () => {
  describe('produce', () => {
    it('sends a single JSON-serialized message preserving the key and headers', async () => {
      const { service, producer } = buildService();

      await service.produce('reservations.events', {
        key: 'program-1',
        payload: { amount: 100 },
        headers: { correlationId: 'abc' },
      });

      expect(producer.send).toHaveBeenCalledWith('reservations.events', [
        {
          key: 'program-1',
          value: JSON.stringify({ amount: 100 }),
          headers: { correlationId: 'abc' },
        },
      ]);
    });

    it('rejects when the topic is empty', async () => {
      const { service } = buildService();

      await expect(
        service.produce('', { key: 'k', payload: {} }),
      ).rejects.toBeInstanceOf(KafkaMessageValidationError);
    });

    it('rejects when the message key is missing', async () => {
      const { service } = buildService();

      await expect(
        service.produce('topic', { key: '', payload: {} }),
      ).rejects.toBeInstanceOf(KafkaMessageValidationError);
    });

    it('never calls the producer when validation fails', async () => {
      const { service, producer } = buildService();

      await expect(
        service.produce('topic', { key: '', payload: {} }),
      ).rejects.toThrow();
      expect(producer.send).not.toHaveBeenCalled();
    });

    it('propagates producer failures', async () => {
      const { service, producer } = buildService();
      producer.send.mockRejectedValue(new Error('broker unavailable'));

      await expect(
        service.produce('topic', { key: 'k', payload: {} }),
      ).rejects.toThrow('broker unavailable');
    });
  });

  describe('produceBatch', () => {
    it('sends every message in a single batch call preserving key/payload/headers', async () => {
      const { service, producer } = buildService();

      await service.produceBatch('reservations.events', [
        { key: 'program-1', payload: { amount: 100 }, headers: { a: '1' } },
        { key: 'program-2', payload: { amount: 200 } },
      ]);

      expect(producer.send).toHaveBeenCalledTimes(1);
      expect(producer.send).toHaveBeenCalledWith('reservations.events', [
        {
          key: 'program-1',
          value: JSON.stringify({ amount: 100 }),
          headers: { a: '1' },
        },
        {
          key: 'program-2',
          value: JSON.stringify({ amount: 200 }),
          headers: undefined,
        },
      ]);
    });

    it('returns without producing for an empty batch', async () => {
      const { service, producer } = buildService();

      await expect(service.produceBatch('topic', [])).resolves.toBeUndefined();
      expect(producer.send).not.toHaveBeenCalled();
    });

    it('rejects when any message in the batch is missing a key', async () => {
      const { service, producer } = buildService();

      await expect(
        service.produceBatch('topic', [
          { key: 'k1', payload: {} },
          { key: '', payload: {} },
        ]),
      ).rejects.toBeInstanceOf(KafkaMessageValidationError);
      expect(producer.send).not.toHaveBeenCalled();
    });
  });
});
