import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthenticatedUser } from './authenticated-user.interface';
import { AuthService } from './auth.service';
import { CurrentRefreshToken } from './decorators/current-refresh-token.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtRefreshAuth } from './decorators/jwt-refresh-auth.decorator';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @JwtRefreshAuth()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @CurrentRefreshToken() refreshToken: string,
  ): Promise<TokenPairResponseDto> {
    const tokens = await this.authService.refreshTokenPair(refreshToken);
    return new TokenPairResponseDto(tokens);
  }

  // Protected by the global access guard by default (no decorator needed) - exists so
  // @CurrentUser()'s normalized shape is independently reachable/testable over HTTP.
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
