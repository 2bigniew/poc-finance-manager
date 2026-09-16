export interface KafkaMessage<T> {
  key?: string;
  payload: T;
  headers?: Record<string, string>;
}
