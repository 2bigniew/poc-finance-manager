import { createParamDecorator, ExecutionContext } from '@nestjs/common';

interface RequestWithRefreshToken {
  user: string;
}

// JwtRefreshStrategy.validate() returns the already-verified raw refresh token string
// (not an AuthenticatedUser - the refresh flow has no use for that shape). Controllers
// still MUST NOT read request.user directly, so this mirrors @CurrentUser() for that case.
export const CurrentRefreshToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithRefreshToken>();
    return request.user;
  },
);
