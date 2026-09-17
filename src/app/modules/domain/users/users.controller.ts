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
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

// Account creation moved to POST /users/register (see UsersAuthController in the auth
// module) since it now also issues tokens. Every route here is protected by the global
// JwtAccessGuard by default - none of them are @Public().
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async list(): Promise<UserResponseDto[]> {
    const users = await this.usersService.list();
    return users.map((user) => new UserResponseDto(user));
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    const user = await this.usersService.get(id);
    return new UserResponseDto(user);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.update(id, dto);
    return new UserResponseDto(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.usersService.delete(id);
  }
}
