import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';

// Owned by Releases, not Reservations: "not active for release" is a concept specific to
// the Release workflow (a Reservation that is RELEASED with no corresponding Release row
// - an invariant violation, since normal RELEASED reservations always have one and are
// handled by the idempotent-retry path instead of this error; see releases.service.ts).
export class ReservationNotActiveError extends ConflictError {
  constructor(reservationId: string, status: string) {
    super(
      `Reservation ${reservationId} cannot be released because its status is ${status}`,
    );
    this.name = 'ReservationNotActiveError';
  }
}
