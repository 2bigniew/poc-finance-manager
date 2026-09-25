import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';

export class ReservationNotFoundError extends NotFoundError {
  constructor(reservationId: string) {
    super(`Reservation ${reservationId} was not found`);
    this.name = 'ReservationNotFoundError';
  }
}
