import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../authenticated-user.interface';

interface RequestWithUser {
  user: AuthenticatedUser;
}

// The only supported way to read the authenticated identity - controllers MUST NOT
// read request.user/req.user directly (SECURITY.md).
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
