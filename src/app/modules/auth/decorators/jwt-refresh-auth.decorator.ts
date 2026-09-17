import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtRefreshGuard } from '../guards/jwt-refresh.guard';
import { SKIP_JWT_ACCESS_KEY } from './skip-jwt-access.metadata';

// /auth/refresh is authenticated by a refresh token, not an access token - it must not
// be @Public(), so this exempts it from the global JwtAccessGuard while binding
// JwtRefreshGuard as the route's real protection.
export function JwtRefreshAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    SetMetadata(SKIP_JWT_ACCESS_KEY, true),
    UseGuards(JwtRefreshGuard),
  );
}
