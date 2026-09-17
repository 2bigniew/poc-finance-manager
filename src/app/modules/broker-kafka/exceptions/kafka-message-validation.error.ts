// Thrown synchronously when a caller-provided KafkaProduceMessage violates the broker
// contract (e.g. missing key) - never reaches the network.
export class KafkaMessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaMessageValidationError';
  }
}
