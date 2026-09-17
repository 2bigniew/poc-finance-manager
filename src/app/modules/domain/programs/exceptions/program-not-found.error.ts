import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';

export class ProgramNotFoundError extends NotFoundError {
  constructor(programId: string) {
    super(`Program ${programId} was not found`);
    this.name = 'ProgramNotFoundError';
  }
}
