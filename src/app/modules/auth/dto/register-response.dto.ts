import { Exclude, Expose } from 'class-transformer';
import { UserResponseDto } from '@app/modules/domain/users/dto/user-response.dto';

@Exclude()
export class RegisterResponseDto {
  @Expose()
  user: UserResponseDto;

  @Expose()
  access_token: string;

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
