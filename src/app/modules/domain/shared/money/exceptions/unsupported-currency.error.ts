import { BadRequestError } from '@app/modules/domain/shared/errors/bad-request.error';

// The caller's fault (an unsupported/unknown currency was requested), so this maps to
// HTTP 400 via DomainExceptionFilter - unlike FxRateUnavailableError/
// InvalidFxRateResponseError, which represent upstream failures rather than bad input.
export class UnsupportedCurrencyError extends BadRequestError {
  constructor(currency: string) {
    super(`Currency ${currency} is not supported for FX conversion`);
    this.name = 'UnsupportedCurrencyError';
  }
}
