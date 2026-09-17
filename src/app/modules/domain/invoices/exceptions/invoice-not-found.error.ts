import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';

export class InvoiceNotFoundError extends NotFoundError {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} was not found`);
    this.name = 'InvoiceNotFoundError';
  }
}
