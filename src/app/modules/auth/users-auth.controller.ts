import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CreateUserDto } from '@app/modules/domain/users/dto/create-user.dto';
import { UserResponseDto } from '@app/modules/domain/users/dto/user-response.dto';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';

// Lives here (not users/) so UsersModule never needs to import AuthModule: this
// controller depends on AuthService, and AuthModule already imports UsersModule for
// UserIdentityProvider - importing it the other way too would be a circular module
// dependency. See ARCHITECTURE.md "do not use forwardRef() to hide circular design."
@Controller('users')
export class UsersAuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() dto: CreateUserDto): Promise<RegisterResponseDto> {
    const { user, accessToken, refreshToken } =
      await this.authService.register(dto);

    return new RegisterResponseDto({
      user: new UserResponseDto(user),
      accessToken,
      refreshToken,
    });
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<TokenPairResponseDto> {
    const tokens = await this.authService.login(dto.email, dto.password);
    return new TokenPairResponseDto(tokens);
  }
}

