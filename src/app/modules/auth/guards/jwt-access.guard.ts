import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SKIP_JWT_ACCESS_KEY } from '../decorators/skip-jwt-access.metadata';

// Registered globally via APP_GUARD (auth.module.ts) - fails closed by default. A route
// bypasses it only via @Public() (truly unauthenticated) or @JwtRefreshAuth() (protected
// by JwtRefreshGuard instead).
@Injectable()
export class JwtAccessGuard extends AuthGuard('jwt-access') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      targets,
    );
    if (isPublic) {
      return true;
    }

    const skipsAccessGuard = this.reflector.getAllAndOverride<boolean>(
      SKIP_JWT_ACCESS_KEY,
      targets,
    );
    if (skipsAccessGuard) {
      return true;
    }

    return super.canActivate(context);
  }
}
