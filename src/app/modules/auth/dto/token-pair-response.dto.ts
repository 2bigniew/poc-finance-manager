import { Exclude, Expose } from 'class-transformer';

// snake_case is a deliberate wire-format exception here (SECURITY.md's documented
// access_token/refresh_token response shape), not the app's usual camelCase convention.
@Exclude()
export class TokenPairResponseDto {
  @Expose()
  access_token: string;

  @Expose()
  refresh_token: string;

  constructor(pair: { accessToken: string; refreshToken: string }) {
    this.access_token = pair.accessToken;
    this.refresh_token = pair.refreshToken;
  }
}
