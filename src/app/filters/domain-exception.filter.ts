import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';
import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';
import type { Response } from 'express';

// Domain errors stay independent of HTTP status codes (CODE_STYLE.md Error Style);
// this is the one place that maps them, so services/controllers never need to know.
@Catch(NotFoundError, ConflictError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: NotFoundError | ConflictError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof NotFoundError
        ? HttpStatus.NOT_FOUND
        : HttpStatus.CONFLICT;

    response.status(status).json({
      statusCode: status,
      message: exception.message,
    });
  }
}
