import { applyDecorators, UseGuards } from '@nestjs/common';
import { JwtAccessGuard } from '../guards/jwt-access.guard';
import { ApiAccessTokenAuth } from './api-access-token-auth.decorator';

// The global JwtAccessGuard already protects every non-@Public() route by default.
// Use this only when a route's access-token requirement should be explicit in source.
export function JwtAccessAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(UseGuards(JwtAccessGuard), ApiAccessTokenAuth());
}
