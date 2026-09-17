import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '@app/modules/domain/users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAccessGuard } from './guards/jwt-access.guard';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { RefreshTokensRepository } from './tokens/refresh-tokens.repository';
import { UsersAuthController } from './users-auth.controller';

@Module({
  // No default secret: AuthService passes access/refresh secrets explicitly per call.
  imports: [ConfigModule, PassportModule, JwtModule.register({}), UsersModule],
  controllers: [AuthController, UsersAuthController],
  providers: [
    AuthService,
    RefreshTokensRepository,
    JwtAccessStrategy,
    JwtRefreshStrategy,
    { provide: APP_GUARD, useClass: JwtAccessGuard },
  ],
})
export class AuthModule {}
