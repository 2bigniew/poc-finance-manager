import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './error-response.dto';

// Documents one error status with the shared ErrorResponseDto body. Several reasons for
// the same status are listed in one description because OpenAPI allows a single
// response entry per status code.
export function ApiErrorResponse(
  status: number,
  ...reasons: string[]
): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    ApiResponse({
      status,
      description: reasons.join(' / '),
      type: ErrorResponseDto,
    }),
  );
}

export const VALIDATION_FAILED =
  'Request validation failed (malformed body, unknown fields, or a non-UUID path id)';
