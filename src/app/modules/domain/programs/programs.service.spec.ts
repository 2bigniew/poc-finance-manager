import { InvalidProgramCapacityError } from './exceptions/invalid-program-capacity.error';
import { ProgramNotFoundError } from './exceptions/program-not-found.error';
import { Program } from './program.entity';
import { ProgramsRepository } from './programs.repository';
import { ProgramsService } from './programs.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'program-id',
    name: 'Test Program',
    originalCapacity: { amount: '1000.0000', currency: 'EUR' },
    totalCapacityUsd: { amount: '1100.0000', currency: 'USD' },
    treasuryVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ProgramsService', () => {
  let service: ProgramsService;
  let programsRepository: {
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    findById: jest.Mock;
    findByIdForUpdate: jest.Mock;
    list: jest.Mock;
    update: jest.Mock<Promise<unknown>, [string, Record<string, unknown>]>;
    delete: jest.Mock;
  };
  let reservedCapacityPort: {
    sumActiveByProgram: jest.Mock<
      Promise<{ amount: string; currency: string }>,
      [string]
    >;
  };

  beforeEach(() => {
    programsRepository = {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findById: jest.fn(),
      findByIdForUpdate: jest.fn(),
      list: jest.fn(),
      update: jest.fn<Promise<unknown>, [string, Record<string, unknown>]>(),
      delete: jest.fn(),
    };
    reservedCapacityPort = {
      sumActiveByProgram: jest
        .fn<Promise<{ amount: string; currency: string }>, [string]>()
        .mockResolvedValue({ amount: '0.0000', currency: 'USD' }),
    };

    service = new ProgramsService(
      programsRepository as unknown as ProgramsRepository,
      reservedCapacityPort,
    );
  });

  describe('create', () => {
    it('generates a UUID for the new program', async () => {
      programsRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      const program = await service.create({
        name: 'Financing Program',
        originalCapacityAmount: '1000',
        originalCapacityCurrency: 'EUR',
        totalCapacityUsdAmount: '1100',
      });

      expect(program.id).toMatch(UUID_PATTERN);
    });

    it('initializes treasuryVersion to 0', async () => {
      programsRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create({
        name: 'Financing Program',
        originalCapacityAmount: '1000',
        originalCapacityCurrency: 'EUR',
        totalCapacityUsdAmount: '1100',
      });

      expect(programsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ treasuryVersion: 0 }),
      );
    });

    it('persists the exact decimal capacity strings without converting to a number', async () => {
      programsRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create({
        name: 'Financing Program',
        originalCapacityAmount: '1234567.89',
        originalCapacityCurrency: 'EUR',
        totalCapacityUsdAmount: '0.10',
      });

      expect(programsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          originalCapacityAmount: '1234567.89',
          totalCapacityUsdAmount: '0.10',
        }),
      );
    });

    it('sets createdAt/updatedAt timestamps', async () => {
      programsRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      const program = await service.create({
        name: 'Financing Program',
        originalCapacityAmount: '1000',
        originalCapacityCurrency: 'EUR',
        totalCapacityUsdAmount: '1100',
      });

      expect(program.createdAt).toBeInstanceOf(Date);
      expect(program.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a negative originalCapacityAmount without calling the repository', async () => {
      await expect(
        service.create({
          name: 'Financing Program',
          originalCapacityAmount: '-1',
          originalCapacityCurrency: 'EUR',
          totalCapacityUsdAmount: '1100',
        }),
      ).rejects.toBeInstanceOf(InvalidProgramCapacityError);
      expect(programsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a negative totalCapacityUsdAmount without calling the repository', async () => {
      await expect(
        service.create({
          name: 'Financing Program',
          originalCapacityAmount: '1000',
          originalCapacityCurrency: 'EUR',
          totalCapacityUsdAmount: '-1100',
        }),
      ).rejects.toBeInstanceOf(InvalidProgramCapacityError);
      expect(programsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric capacity amount', async () => {
      await expect(
        service.create({
          name: 'Financing Program',
          originalCapacityAmount: 'not-a-number',
          originalCapacityCurrency: 'EUR',
          totalCapacityUsdAmount: '1100',
        }),
      ).rejects.toBeInstanceOf(InvalidProgramCapacityError);
    });
  });

  describe('get', () => {
    it('returns an existing program', async () => {
      const program = buildProgram();
      programsRepository.findById.mockResolvedValue(program);

      await expect(service.get(program.id)).resolves.toBe(program);
    });

    it('throws ProgramNotFoundError when missing', async () => {
      programsRepository.findById.mockResolvedValue(null);

      await expect(service.get('missing-id')).rejects.toBeInstanceOf(
        ProgramNotFoundError,
      );
    });
  });

  describe('list', () => {
    it('returns programs from the repository', async () => {
      const programs = [buildProgram()];
      programsRepository.list.mockResolvedValue(programs);

      await expect(service.list()).resolves.toBe(programs);
    });
  });

  describe('update', () => {
    it('updates the name of an existing program', async () => {
      const updated = buildProgram({ name: 'Renamed Program' });
      programsRepository.update.mockResolvedValue(updated);

      await expect(
        service.update('program-id', { name: 'Renamed Program' }),
      ).resolves.toBe(updated);
      expect(programsRepository.update).toHaveBeenCalledWith(
        'program-id',
        expect.objectContaining({ name: 'Renamed Program' }),
      );
    });

    it('does not include name in the patch when omitted', async () => {
      programsRepository.update.mockResolvedValue(buildProgram());

      await service.update('program-id', {});

      const patchArg = programsRepository.update.mock.calls[0]?.[1];
      expect(patchArg).not.toHaveProperty('name');
    });

    it('sets a fresh updatedAt on every update', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      programsRepository.update.mockResolvedValue(buildProgram());

      await service.update('program-id', {});

      expect(programsRepository.update).toHaveBeenCalledWith(
        'program-id',
        expect.objectContaining({
          updatedAt: new Date('2026-06-01T12:00:00.000Z'),
        }),
      );
      jest.useRealTimers();
    });

    it('throws ProgramNotFoundError when the program does not exist', async () => {
      programsRepository.update.mockResolvedValue(null);

      await expect(
        service.update('missing-id', { name: 'x' }),
      ).rejects.toBeInstanceOf(ProgramNotFoundError);
    });
  });

  describe('delete', () => {
    it('deletes an existing program', async () => {
      programsRepository.delete.mockResolvedValue(true);

      await expect(service.delete('program-id')).resolves.toBeUndefined();
    });

    it('throws ProgramNotFoundError when missing', async () => {
      programsRepository.delete.mockResolvedValue(false);

      await expect(service.delete('missing-id')).rejects.toBeInstanceOf(
        ProgramNotFoundError,
      );
    });
  });

  describe('getCapacitySummary', () => {
    it('returns zero reserved and full available capacity when there are no active reservations', async () => {
      const program = buildProgram({
        totalCapacityUsd: { amount: '1000.0000', currency: 'USD' },
      });
      reservedCapacityPort.sumActiveByProgram.mockResolvedValue({
        amount: '0.0000',
        currency: 'USD',
      });

      const summary = await service.getCapacitySummary(program);

      expect(reservedCapacityPort.sumActiveByProgram).toHaveBeenCalledWith(
        program.id,
      );
      expect(summary.reservedCapacityUsd).toEqual({
        amount: '0.0000',
        currency: 'USD',
      });
      expect(summary.availableCapacityUsd).toEqual({
        amount: '1000.0000',
        currency: 'USD',
      });
    });

    it('derives availableCapacityUsd as totalCapacityUsd minus the real active-reservation sum', async () => {
      const program = buildProgram({
        totalCapacityUsd: { amount: '1000.0000', currency: 'USD' },
      });
      reservedCapacityPort.sumActiveByProgram.mockResolvedValue({
        amount: '300.0000',
        currency: 'USD',
      });

      const summary = await service.getCapacitySummary(program);

      expect(summary.reservedCapacityUsd).toEqual({
        amount: '300.0000',
        currency: 'USD',
      });
      expect(summary.availableCapacityUsd).toEqual({
        amount: '700.0000',
        currency: 'USD',
      });
    });

    it('reports exactly zero available capacity when fully reserved', async () => {
      const program = buildProgram({
        totalCapacityUsd: { amount: '100.0000', currency: 'USD' },
      });
      reservedCapacityPort.sumActiveByProgram.mockResolvedValue({
        amount: '100.0000',
        currency: 'USD',
      });

      const summary = await service.getCapacitySummary(program);

      expect(summary.availableCapacityUsd).toEqual({
        amount: '0.0000',
        currency: 'USD',
      });
    });
  });

  describe('findByIdForUpdate', () => {
    it('delegates to ProgramsRepository.findByIdForUpdate with the given executor', async () => {
      const program = buildProgram();
      programsRepository.findByIdForUpdate.mockResolvedValue(program);
      const executor = { marker: 'trx' };

      const result = await service.findByIdForUpdate(
        program.id,
        executor as never,
      );

      expect(programsRepository.findByIdForUpdate).toHaveBeenCalledWith(
        program.id,
        executor,
      );
      expect(result).toBe(program);
    });
  });
});
