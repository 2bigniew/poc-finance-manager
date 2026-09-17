// Thrown when a consumed Kafka message has no value or fails JSON parsing. Treated as an
// ordinary processing failure and routed through the normal retry/DLQ flow (CLAUDE.md
// section 23: "Malformed JSON MUST fail processing and follow normal retry/DLQ behavior").
export class KafkaMessageParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KafkaMessageParseError';
  }
}
