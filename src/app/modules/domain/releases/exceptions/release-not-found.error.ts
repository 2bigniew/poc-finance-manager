import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';

export class ReleaseNotFoundError extends NotFoundError {
  constructor(releaseId: string) {
    super(`Release ${releaseId} was not found`);
    this.name = 'ReleaseNotFoundError';
  }
}
