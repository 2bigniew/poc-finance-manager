import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';

export class UserEmailAlreadyExistsError extends ConflictError {
  constructor(email: string) {
    super(`User with email ${email} already exists`);
    this.name = 'UserEmailAlreadyExistsError';
  }
}
