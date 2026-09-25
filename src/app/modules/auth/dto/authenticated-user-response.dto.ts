import { ApiProperty } from '@nestjs/swagger';
import { AuthenticatedUser } from '../authenticated-user.interface';

// OpenAPI schema of GET /auth/me, which returns the AuthenticatedUser resolved by
// @CurrentUser(). Documentation only.
export class AuthenticatedUserResponseDto implements AuthenticatedUser {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id!: string;

  @ApiProperty({ type: String, format: 'email', example: 'demo@example.com' })
  email!: string;

  @ApiProperty({ type: String, enum: ['jwt'], example: 'jwt' })
  authMethod!: 'jwt';
}
