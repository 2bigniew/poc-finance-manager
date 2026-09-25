import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrorResponse,
  VALIDATION_FAILED,
} from '@app/filters/api-error-response.decorator';
import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { ApiAccessTokenAuth } from '@app/modules/auth/decorators/api-access-token-auth.decorator';
import { CurrentUser } from '@app/modules/auth/decorators/current-user.decorator';
import { ReleaseResponseDto } from './dto/release-response.dto';
import { ReleasesService } from './releases.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token). Release
// is a business command, not CRUD: no PATCH/DELETE, no PATCH on Reservation status, and
// creator identity comes only from @CurrentUser(), never the request body (CLAUDE.md
// sections 5/6/20/33). The route has no request body at all - the path Reservation
// determines all domain context (CLAUDE.md section 20).
@ApiTags('Releases')
@ApiAccessTokenAuth()
@Controller()
export class ReleasesController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Post('reservations/:reservationId/release')
  @ApiOperation({
    operationId: 'releaseReservation',
    summary: 'Release reservation (full repayment)',
    description:
      "Business command with no request body. Marks the Reservation RELEASED and its Invoice REPAID, and restores exactly the Reservation's stored USD amount to the Program, reusing its FX snapshot (no new FX conversion). Only full release is supported. Idempotent: repeating the command for an already released Reservation returns the existing Release (201) and does not restore capacity twice.",
  })
  @ApiParam({
    name: 'reservationId',
    format: 'uuid',
    description: 'Reservation to release',
    example: '550e8400-e29b-41d4-a716-446655440002',
  })
  @ApiCreatedResponse({
    type: ReleaseResponseDto,
    description: 'The new Release, or the existing one on a repeated request',
  })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Reservation not found')
  @ApiErrorResponse(
    409,
    'Reservation/Invoice in an inconsistent state that cannot be released',
  )
  async release(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReleaseResponseDto> {
    const release = await this.releasesService.release(reservationId, user.id);
    return new ReleaseResponseDto(release);
  }

  @Get('releases/:id')
  @ApiOperation({ operationId: 'getRelease', summary: 'Get a release' })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Release id',
    example: '550e8400-e29b-41d4-a716-446655440004',
  })
  @ApiOkResponse({ type: ReleaseResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Release not found')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReleaseResponseDto> {
    const release = await this.releasesService.get(id);
    return new ReleaseResponseDto(release);
  }
}
