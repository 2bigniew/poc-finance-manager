import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';

// Owned by Releases, not Invoices: "releasable" is a concept specific to the
// Release workflow (an Invoice not currently RESERVED). InvoicesModule has no notion of
// Reservations/Releases at all, and should not need one just for this error to exist
// (same convention as reservations/exceptions/invoice-not-reservable.error.ts).
export class InvoiceNotReleasableError extends ConflictError {
  constructor(invoiceId: string, status: string) {
    super(
      `Invoice ${invoiceId} cannot be released because its status is ${status}`,
    );
    this.name = 'InvoiceNotReleasableError';
  }
}
