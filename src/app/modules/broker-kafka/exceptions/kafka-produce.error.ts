// Wraps a kafkajs producer failure at the broker boundary so callers never see raw
// KafkaJSError types (CODE_STYLE.md: infrastructure errors are translated at their
// boundary).
export class KafkaProduceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KafkaProduceError';
  }
}
