import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { ApiErrorResponse } from '@app/filters/api-error-response.decorator';

// OpenAPI security scheme name for access JWTs (registered in configure-swagger.ts).
export const ACCESS_TOKEN_SECURITY_SCHEME = 'access-token';

// Documentation only: marks routes as requiring an access JWT in the OpenAPI document.
// Enforcement is the global JwtAccessGuard, which protects every non-@Public() route
// whether or not this decorator is present.
export function ApiAccessTokenAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    ApiBearerAuth(ACCESS_TOKEN_SECURITY_SCHEME),
    ApiErrorResponse(401, 'Missing, invalid, or expired access token'),
  );
}
