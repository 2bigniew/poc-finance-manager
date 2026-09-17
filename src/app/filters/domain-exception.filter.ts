import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { BadRequestError } from '@app/modules/domain/shared/errors/bad-request.error';
import { ConflictError } from '@app/modules/domain/shared/errors/conflict.error';
import { NotFoundError } from '@app/modules/domain/shared/errors/not-found.error';
import type { Response } from 'express';

// Domain errors stay independent of HTTP status codes (CODE_STYLE.md Error Style);
// this is the one place that maps them, so services/controllers never need to know.
@Catch(NotFoundError, ConflictError, BadRequestError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(
    exception: NotFoundError | ConflictError | BadRequestError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = DomainExceptionFilter.statusFor(exception);

    response.status(status).json({
      statusCode: status,
      message: exception.message,
    });
  }

  private static statusFor(
    exception: NotFoundError | ConflictError | BadRequestError,
  ): HttpStatus {
    if (exception instanceof NotFoundError) {
      return HttpStatus.NOT_FOUND;
    }
    if (exception instanceof ConflictError) {
      return HttpStatus.CONFLICT;
    }
    return HttpStatus.BAD_REQUEST;
  }
}
