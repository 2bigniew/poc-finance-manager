export const KAFKA_CLIENT = 'KAFKA_CLIENT';
export const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

// Used by @ConsumeBatch() when the decorator omits batchSize (CLAUDE.md: "Provide a
// reasonable validated default if omitted").
export const DEFAULT_CONSUME_BATCH_SIZE = 100;
