import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';

// The core invariant this whole module protects: capacity math is exact decimal
// (never JS float) - see reservations.service.ts's capacity check.
export class InsufficientCapacityError extends ConflictError {
  constructor(
    programId: string,
    requestedAmountUsd: string,
    availableAmountUsd: string,
  ) {
    super(
      `Program ${programId} has insufficient available capacity: requested ${requestedAmountUsd} USD, available ${availableAmountUsd} USD`,
    );
    this.name = 'InsufficientCapacityError';
  }
}
