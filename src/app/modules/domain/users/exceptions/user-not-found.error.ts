import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';

export class UserNotFoundError extends NotFoundError {
  constructor(userId: string) {
    super(`User ${userId} was not found`);
    this.name = 'UserNotFoundError';
  }
}
