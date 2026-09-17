// Frankfurter responded, but the body failed runtime validation (missing/wrong-typed
// fields, non-positive rate, unparseable date, ...) - an upstream data-quality problem,
// not caller input. Same reasoning as FxRateUnavailableError for not extending an
// HTTP-mapped base: this is not the client's fault.
export class InvalidFxRateResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFxRateResponseError';
  }
}
