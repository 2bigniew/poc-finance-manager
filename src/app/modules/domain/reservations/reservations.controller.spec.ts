import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { Reservation } from './reservation.entity';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

function buildReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'reservation-id',
    programId: 'program-id',
    invoiceId: 'invoice-id',
    originalMoney: { amount: '80.0000', currency: 'USD' },
    convertedMoneyUsd: { amount: '80.0000', currency: 'USD' },
    conversion: {
      original: { amount: '80.0000', currency: 'USD' },
      converted: { amount: '80.0000', currency: 'USD' },
      rate: '1',
      rateDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    status: 'ACTIVE',
    createdByUserId: 'caller-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const authenticatedUser: AuthenticatedUser = {
  id: 'caller-id',
  email: 'caller@example.test',
  authMethod: 'jwt',
};

describe('ReservationsController', () => {
  let controller: ReservationsController;
  let reservationsService: { create: jest.Mock; get: jest.Mock };

  beforeEach(() => {
    reservationsService = {
      create: jest.fn(),
      get: jest.fn(),
    };
    controller = new ReservationsController(
      reservationsService as unknown as ReservationsService,
    );
  });

  it('forwards programId, CreateReservationDto and the current user id to ReservationsService.create', async () => {
    const dto: CreateReservationDto = { invoiceId: 'invoice-id' };
    const reservation = buildReservation();
    reservationsService.create.mockResolvedValue(reservation);

    const result = await controller.create(
      'program-id',
      dto,
      authenticatedUser,
    );

    expect(reservationsService.create).toHaveBeenCalledWith(
      'program-id',
      dto,
      authenticatedUser.id,
    );
    expect(result.id).toBe(reservation.id);
  });

  it('never lets the client choose createdByUserId - it always comes from @CurrentUser()', async () => {
    reservationsService.create.mockResolvedValue(buildReservation());

    await controller.create(
      'program-id',
      { invoiceId: 'invoice-id' },
      authenticatedUser,
    );

    const [, , createdByUserIdArg] = reservationsService.create.mock
      .calls[0] as [string, CreateReservationDto, string];
    expect(createdByUserIdArg).toBe(authenticatedUser.id);
  });

  it('forwards the id param to ReservationsService.get and returns the response DTO', async () => {
    const reservation = buildReservation();
    reservationsService.get.mockResolvedValue(reservation);

    const result = await controller.get(reservation.id);

    expect(reservationsService.get).toHaveBeenCalledWith(reservation.id);
    expect(result.id).toBe(reservation.id);
  });

  it('only exposes rate/rateDate/source under conversion, not the redundant original/converted', async () => {
    reservationsService.get.mockResolvedValue(buildReservation());

    const result = await controller.get('reservation-id');

    expect(Object.keys(result.conversion).sort()).toEqual(
      ['rate', 'rateDate', 'source'].sort(),
    );
  });

  it('never exposes internal fields beyond the response DTO contract', async () => {
    reservationsService.get.mockResolvedValue(buildReservation());

    const result = await controller.get('reservation-id');

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'programId',
        'invoiceId',
        'originalMoney',
        'convertedMoneyUsd',
        'conversion',
        'status',
        'createdByUserId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});
