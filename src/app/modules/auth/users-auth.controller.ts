import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrorResponse,
  VALIDATION_FAILED,
} from '@app/filters/api-error-response.decorator';
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
@ApiTags('Authentication')
@Controller('users')
export class UsersAuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({
    operationId: 'registerUser',
    summary: 'Register a user',
    description:
      'Creates a user and immediately issues an access/refresh JWT pair. Public.',
  })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(409, 'Email is already registered')
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
  @ApiOperation({
    operationId: 'loginUser',
    summary: 'Login and issue JWT pair',
    description:
      'Verifies email/password and issues a new access/refresh JWT pair. Public.',
  })
  @ApiOkResponse({ type: TokenPairResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(401, 'Invalid email or password')
  async login(@Body() dto: LoginDto): Promise<TokenPairResponseDto> {
    const tokens = await this.authService.login(dto.email, dto.password);
    return new TokenPairResponseDto(tokens);
  }
}
