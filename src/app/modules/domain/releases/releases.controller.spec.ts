import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { Release } from './release.entity';
import { ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';

function buildRelease(overrides: Partial<Release> = {}): Release {
  return {
    id: 'release-id',
    reservationId: 'reservation-id',
    invoiceId: 'invoice-id',
    programId: 'program-id',
    originalMoney: { amount: '80.0000', currency: 'USD' },
    convertedMoneyUsd: { amount: '80.0000', currency: 'USD' },
    conversion: {
      original: { amount: '80.0000', currency: 'USD' },
      converted: { amount: '80.0000', currency: 'USD' },
      rate: '1',
      rateDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
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

describe('ReleasesController', () => {
  let controller: ReleasesController;
  let releasesService: { release: jest.Mock; get: jest.Mock };

  beforeEach(() => {
    releasesService = {
      release: jest.fn(),
      get: jest.fn(),
    };
    controller = new ReleasesController(
      releasesService as unknown as ReleasesService,
    );
  });

  it('forwards reservationId and the current user id to ReleasesService.release', async () => {
    const release = buildRelease();
    releasesService.release.mockResolvedValue(release);

    const result = await controller.release(
      'reservation-id',
      authenticatedUser,
    );

    expect(releasesService.release).toHaveBeenCalledWith(
      'reservation-id',
      authenticatedUser.id,
    );
    expect(result.id).toBe(release.id);
  });

  it('never lets the client choose createdByUserId - it always comes from @CurrentUser()', async () => {
    releasesService.release.mockResolvedValue(buildRelease());

    await controller.release('reservation-id', authenticatedUser);

    const [, createdByUserIdArg] = releasesService.release.mock.calls[0] as [
      string,
      string,
    ];
    expect(createdByUserIdArg).toBe(authenticatedUser.id);
  });

  it('forwards the id param to ReleasesService.get and returns the response DTO', async () => {
    const release = buildRelease();
    releasesService.get.mockResolvedValue(release);

    const result = await controller.get(release.id);

    expect(releasesService.get).toHaveBeenCalledWith(release.id);
    expect(result.id).toBe(release.id);
  });

  it('only exposes rate/rateDate/source under conversion, not the redundant original/converted', async () => {
    releasesService.get.mockResolvedValue(buildRelease());

    const result = await controller.get('release-id');

    expect(Object.keys(result.conversion).sort()).toEqual(
      ['rate', 'rateDate', 'source'].sort(),
    );
  });

  it('never exposes internal fields beyond the response DTO contract', async () => {
    releasesService.get.mockResolvedValue(buildRelease());

    const result = await controller.get('release-id');

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'reservationId',
        'invoiceId',
        'programId',
        'originalMoney',
        'convertedMoneyUsd',
        'conversion',
        'createdByUserId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});
