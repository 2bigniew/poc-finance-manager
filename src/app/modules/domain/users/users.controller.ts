import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrorResponse,
  VALIDATION_FAILED,
} from '@app/filters/api-error-response.decorator';
import { ApiAccessTokenAuth } from '@app/modules/auth/decorators/api-access-token-auth.decorator';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

const USER_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description: 'User id',
  example: '550e8400-e29b-41d4-a716-446655440001',
} as const;

// Account creation moved to POST /users/register (see UsersAuthController in the auth
// module) since it now also issues tokens. Every route here is protected by the global
// JwtAccessGuard by default - none of them are @Public().
@ApiTags('Users')
@ApiAccessTokenAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ operationId: 'listUsers', summary: 'List users' })
  @ApiOkResponse({ type: UserResponseDto, isArray: true })
  async list(): Promise<UserResponseDto[]> {
    const users = await this.usersService.list();
    return users.map((user) => new UserResponseDto(user));
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getUser', summary: 'Get a user' })
  @ApiParam(USER_ID_PARAM)
  @ApiOkResponse({ type: UserResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'User not found')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    const user = await this.usersService.get(id);
    return new UserResponseDto(user);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'updateUser', summary: "Change a user's email" })
  @ApiParam(USER_ID_PARAM)
  @ApiOkResponse({ type: UserResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'User not found')
  @ApiErrorResponse(409, 'Email is already registered')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.update(id, dto);
    return new UserResponseDto(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'deleteUser',
    summary: 'Delete a user',
    description:
      "The user's refresh tokens are deleted with it. Users that created Invoices, Reservations, or Releases cannot be deleted.",
  })
  @ApiParam(USER_ID_PARAM)
  @ApiNoContentResponse({ description: 'User deleted' })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'User not found')
  @ApiErrorResponse(
    500,
    'User is still referenced by Invoices/Reservations/Releases (database restriction, not yet mapped to 409)',
  )
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.usersService.delete(id);
  }
}
