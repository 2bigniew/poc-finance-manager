// Internal to @JwtRefreshAuth()/JwtAccessGuard: marks a route as authenticated by a
// different guard, so the global access guard steps aside without treating it as
// @Public() (SECURITY.md requires /auth/refresh to stay authenticated, just not by an
// access token).
export const SKIP_JWT_ACCESS_KEY = 'skipJwtAccess';
