import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from './authenticated-user.interface';
import { AuthService } from './auth.service';
import { ApiAccessTokenAuth } from './decorators/api-access-token-auth.decorator';
import { CurrentRefreshToken } from './decorators/current-refresh-token.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtRefreshAuth } from './decorators/jwt-refresh-auth.decorator';
import { AuthenticatedUserResponseDto } from './dto/authenticated-user-response.dto';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @JwtRefreshAuth()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'refreshToken',
    summary: 'Rotate refresh token',
    description:
      'Exchanges a refresh JWT, sent in the JSON body as `refresh_token` (not as a Bearer header), for a new access/refresh pair. The submitted refresh token is invalidated: reusing it returns 401. An access token is not accepted here, and a refresh token is not accepted by domain endpoints.',
  })
  @ApiOkResponse({ type: TokenPairResponseDto })
  async refresh(
    @CurrentRefreshToken() refreshToken: string,
  ): Promise<TokenPairResponseDto> {
    const tokens = await this.authService.refreshTokenPair(refreshToken);
    return new TokenPairResponseDto(tokens);
  }

  // Protected by the global access guard by default (no decorator needed) - exists so
  // @CurrentUser()'s normalized shape is independently reachable/testable over HTTP.
  @Get('me')
  @ApiAccessTokenAuth()
  @ApiOperation({
    operationId: 'getCurrentUser',
    summary: 'Get the authenticated identity',
    description: 'Returns the identity resolved from the access token.',
  })
  @ApiOkResponse({ type: AuthenticatedUserResponseDto })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
