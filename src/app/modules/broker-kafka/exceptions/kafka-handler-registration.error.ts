// Thrown at decoration time or during startup discovery when a @ConsumeOneMessage/
// @ConsumeBatch handler cannot be safely registered - fails application startup instead
// of silently ignoring the handler (CLAUDE.md section 13).
export class KafkaHandlerRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaHandlerRegistrationError';
  }
}
