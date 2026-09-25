import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';

// Thrown when the database's partial unique index (reservations_invoice_active_unique)
// rejects a second ACTIVE Reservation for the same Invoice - the service also checks
// this precondition before writing, but the DB constraint is the final authority under
// concurrency (CLAUDE.md: "Preserve both layers: service precondition + database
// constraint").
export class ReservationAlreadyExistsError extends ConflictError {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} already has an active Reservation`);
    this.name = 'ReservationAlreadyExistsError';
  }
}
