import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';

// Owned by Reservations, not Invoices: "reservable" is a concept specific to the
// Reservation-creation workflow (an Invoice not currently OPEN). InvoicesModule has no
// notion of Reservations at all, and should not need one just for this error to exist.
export class InvoiceNotReservableError extends ConflictError {
  constructor(invoiceId: string, status: string) {
    super(
      `Invoice ${invoiceId} cannot be reserved because its status is ${status}`,
    );
    this.name = 'InvoiceNotReservableError';
  }
}
