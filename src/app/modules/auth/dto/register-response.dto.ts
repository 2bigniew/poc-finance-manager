import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { UserResponseDto } from '@app/modules/domain/users/dto/user-response.dto';

@Exclude()
export class RegisterResponseDto {
  @ApiProperty({ type: () => UserResponseDto })
  @Expose()
  user: UserResponseDto;

  @ApiProperty({
    type: String,
    description: 'Access JWT for the newly registered user.',
    example: '<access-jwt>',
  })
  @Expose()
  access_token: string;

  @ApiProperty({
    type: String,
    description: 'Refresh JWT for the newly registered user.',
    example: '<refresh-jwt>',
  })
  @Expose()
  refresh_token: string;

  constructor(params: {
    user: UserResponseDto;
    accessToken: string;
    refreshToken: string;
  }) {
    this.user = params.user;
    this.access_token = params.accessToken;
    this.refresh_token = params.refreshToken;
  }
}
