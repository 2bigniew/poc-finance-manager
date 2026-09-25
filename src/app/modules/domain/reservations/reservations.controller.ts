import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
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
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationResponseDto } from './dto/reservation-response.dto';
import { ReservationsService } from './reservations.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token).
// No PATCH/DELETE: a Reservation's lifecycle (ACTIVE -> RELEASED) is owned by domain
// actions (the future Release operation), not generic CRUD (CLAUDE.md section 33).
@ApiTags('Reservations')
@ApiAccessTokenAuth()
@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('programs/:programId/reservations')
  @ApiOperation({
    operationId: 'createReservation',
    summary: 'Reserve invoice capacity',
    description:
      "Creates an ACTIVE Reservation of an OPEN Invoice against the Program and marks the Invoice RESERVED. The Invoice's stored USD amount and FX snapshot become the Reservation's snapshot; no new conversion happens. The Program row is locked, so concurrent requests cannot oversubscribe capacity. An Invoice can have at most one ACTIVE Reservation.",
  })
  @ApiParam({
    name: 'programId',
    format: 'uuid',
    description: 'Program whose capacity is consumed',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  @ApiCreatedResponse({ type: ReservationResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Program not found', 'Invoice not found')
  @ApiErrorResponse(
    409,
    'Insufficient available capacity',
    'Invoice is not OPEN (already reserved or repaid)',
    'Invoice already has an ACTIVE Reservation',
  )
  async create(
    @Param('programId', ParseUUIDPipe) programId: string,
    @Body() dto: CreateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationResponseDto> {
    const reservation = await this.reservationsService.create(
      programId,
      dto,
      user.id,
    );
    return new ReservationResponseDto(reservation);
  }

  @Get('reservations/:id')
  @ApiOperation({ operationId: 'getReservation', summary: 'Get a reservation' })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Reservation id',
    example: '550e8400-e29b-41d4-a716-446655440002',
  })
  @ApiOkResponse({ type: ReservationResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Reservation not found')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReservationResponseDto> {
    const reservation = await this.reservationsService.get(id);
    return new ReservationResponseDto(reservation);
  }
}
