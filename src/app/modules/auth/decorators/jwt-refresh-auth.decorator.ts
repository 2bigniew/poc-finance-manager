import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { ApiErrorResponse } from '@app/filters/api-error-response.decorator';
import { RefreshTokenRequestDto } from '../dto/refresh-token-request.dto';
import { JwtRefreshGuard } from '../guards/jwt-refresh.guard';
import { SKIP_JWT_ACCESS_KEY } from './skip-jwt-access.metadata';

// /auth/refresh is authenticated by a refresh token, not an access token - it must not
// be @Public(), so this exempts it from the global JwtAccessGuard while binding
// JwtRefreshGuard as the route's real protection. The Swagger decorators only describe
// that transport (refresh JWT in the request body, no Bearer access token).
export function JwtRefreshAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    SetMetadata(SKIP_JWT_ACCESS_KEY, true),
    UseGuards(JwtRefreshGuard),
    ApiBody({ type: RefreshTokenRequestDto }),
    ApiErrorResponse(
      401,
      'Missing, invalid, expired, revoked, or already-rotated (reused) refresh token, or an access token supplied instead',
    ),
  );
}
