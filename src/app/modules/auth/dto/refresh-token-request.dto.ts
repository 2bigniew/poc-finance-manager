import { ApiProperty } from '@nestjs/swagger';

// OpenAPI schema of the POST /auth/refresh body. Documentation only: the token is read
// and verified by JwtRefreshStrategy (ExtractJwt.fromBodyField('refresh_token')) inside
// JwtRefreshGuard, not bound through a validated @Body() parameter.
export class RefreshTokenRequestDto {
  @ApiProperty({
    type: String,
    description:
      'Refresh JWT from the last register/login/refresh response. Access tokens are rejected here.',
    example: '<refresh-jwt>',
  })
  refresh_token!: string;
}
