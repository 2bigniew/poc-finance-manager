import { BadRequestError } from '@app/modules/domain/shared/errors/bad-request.error';

// CurrencyExchangeService's own defensive precondition check on its Money input,
// independent of whichever domain module's own DTO/service validation ran first
// (defense in depth for a capability other modules besides Invoices will call later).
export class InvalidMoneyAmountError extends BadRequestError {
  constructor(amount: string) {
    super(`Money amount "${amount}" is not a valid non-negative decimal value`);
    this.name = 'InvalidMoneyAmountError';
  }
}
