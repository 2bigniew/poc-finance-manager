// The FX provider (Frankfurter) could not be reached or returned a failure status - an
// upstream dependency problem, not caller input. Intentionally does not extend any of
// the shared HTTP-mapped error bases (NotFound/Conflict/BadRequest); left uncaught it
// falls through to NestJS's default 500 handling, which is a reasonable default for
// "an external dependency is unavailable" without inventing a new 502/503 mapping this
// step doesn't otherwise need.
export class FxRateUnavailableError extends Error {
  constructor(from: string, to: string, options?: { cause?: unknown }) {
    super(`FX rate ${from}->${to} is unavailable`, options);
    this.name = 'FxRateUnavailableError';
  }
}
