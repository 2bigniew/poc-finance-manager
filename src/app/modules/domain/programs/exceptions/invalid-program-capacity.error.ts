import { BadRequestError } from '@app/modules/domain/shared/errors/bad-request.error';

export class InvalidProgramCapacityError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProgramCapacityError';
  }
}
