import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';

// snake_case is a deliberate wire-format exception here (SECURITY.md's documented
// access_token/refresh_token response shape), not the app's usual camelCase convention.
@Exclude()
export class TokenPairResponseDto {
  @ApiProperty({
    type: String,
    description:
      'Short-lived access JWT. Send as "Authorization: Bearer <token>" to domain endpoints.',
    example: '<access-jwt>',
  })
  @Expose()
  access_token: string;

  @ApiProperty({
    type: String,
    description:
      'Refresh JWT. Only accepted in the POST /auth/refresh body; single-use (rotated on every refresh).',
    example: '<refresh-jwt>',
  })
  @Expose()
  refresh_token: string;

  constructor(pair: { accessToken: string; refreshToken: string }) {
    this.access_token = pair.accessToken;
    this.refresh_token = pair.refreshToken;
  }
}
