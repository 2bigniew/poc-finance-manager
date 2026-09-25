import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { CurrentUser } from '@app/modules/auth/decorators/current-user.decorator';
import { ReleaseResponseDto } from './dto/release-response.dto';
import { ReleasesService } from './releases.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token). Release
// is a business command, not CRUD: no PATCH/DELETE, no PATCH on Reservation status, and
// creator identity comes only from @CurrentUser(), never the request body (CLAUDE.md
// sections 5/6/20/33). The route has no request body at all - the path Reservation
// determines all domain context (CLAUDE.md section 20).
@Controller()
export class ReleasesController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Post('reservations/:reservationId/release')
  async release(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReleaseResponseDto> {
    const release = await this.releasesService.release(reservationId, user.id);
    return new ReleaseResponseDto(release);
  }

  @Get('releases/:id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReleaseResponseDto> {
    const release = await this.releasesService.get(id);
    return new ReleaseResponseDto(release);
  }
}
