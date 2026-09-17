import { ConfigService } from '@nestjs/config';
import { KafkaRetryService } from './kafka-retry.service';

function buildService(
  overrides: Partial<{
    retryAttempts: number;
    retryDelayMs: number;
    deadLetterTopicSuffix: string;
  }> = {},
): KafkaRetryService {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue({
      retryAttempts: 3,
      retryDelayMs: 500,
      deadLetterTopicSuffix: '.dlq',
      ...overrides,
    }),
  };

  return new KafkaRetryService(configService as unknown as ConfigService);
}

describe('KafkaRetryService', () => {
  describe('resolveRetryOptions', () => {
    it('falls back to the configured defaults when no override is given', () => {
      const service = buildService({ retryAttempts: 5, retryDelayMs: 250 });

      expect(service.resolveRetryOptions()).toEqual({
        attempts: 5,
        delayMs: 250,
      });
    });

    it('applies a per-handler override on top of the defaults', () => {
      const service = buildService({ retryAttempts: 3, retryDelayMs: 500 });

      expect(service.resolveRetryOptions({ attempts: 7 })).toEqual({
        attempts: 7,
        delayMs: 500,
      });
    });

    it('clamps attempts below 1 up to 1', () => {
      const service = buildService();

      expect(service.resolveRetryOptions({ attempts: 0 }).attempts).toBe(1);
    });

    it('clamps a negative delay up to 0', () => {
      const service = buildService();

      expect(service.resolveRetryOptions({ delayMs: -10 }).delayMs).toBe(0);
    });
  });

  describe('computeDelayMs', () => {
    it('grows exponentially with the attempt number', () => {
      const service = buildService();

      expect(service.computeDelayMs(1, 100)).toBe(100);
      expect(service.computeDelayMs(2, 100)).toBe(200);
      expect(service.computeDelayMs(3, 100)).toBe(400);
    });
  });

  describe('resolveDeadLetterTopic', () => {
    it('appends the configured suffix to the original topic', () => {
      const service = buildService({ deadLetterTopicSuffix: '.dlq' });

      expect(service.resolveDeadLetterTopic('reservations.events')).toBe(
        'reservations.events.dlq',
      );
    });

    it('uses whatever suffix is configured', () => {
      const service = buildService({ deadLetterTopicSuffix: '-dead-letter' });

      expect(service.resolveDeadLetterTopic('topic')).toBe('topic-dead-letter');
    });
  });
});
