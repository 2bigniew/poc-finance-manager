import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { CurrentUser } from '@app/modules/auth/decorators/current-user.decorator';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationResponseDto } from './dto/reservation-response.dto';
import { ReservationsService } from './reservations.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token).
// No PATCH/DELETE: a Reservation's lifecycle (ACTIVE -> RELEASED) is owned by domain
// actions (the future Release operation), not generic CRUD (CLAUDE.md section 33).
@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('programs/:programId/reservations')
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
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReservationResponseDto> {
    const reservation = await this.reservationsService.get(id);
    return new ReservationResponseDto(reservation);
  }
}
