import { BadRequestError } from '@app/modules/domain/shared/errors/bad-request.error';

export class InvalidInvoiceAmountError extends BadRequestError {
  constructor(amount: string) {
    super(`Invoice amount "${amount}" must be a non-negative decimal value`);
    this.name = 'InvalidInvoiceAmountError';
  }
}
