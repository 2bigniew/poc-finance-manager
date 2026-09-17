import { CreateProgramDto } from './dto/create-program.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { Program, ProgramCapacitySummary } from './program.entity';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';

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

function buildCapacitySummary(
  overrides: Partial<ProgramCapacitySummary> = {},
): ProgramCapacitySummary {
  return {
    reservedCapacityUsd: { amount: '0.0000', currency: 'USD' },
    availableCapacityUsd: { amount: '1100.0000', currency: 'USD' },
    ...overrides,
  };
}

describe('ProgramsController', () => {
  let controller: ProgramsController;
  let programsService: {
    create: jest.Mock;
    get: jest.Mock;
    list: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    getCapacitySummary: jest.Mock;
  };

  beforeEach(() => {
    programsService = {
      create: jest.fn(),
      get: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getCapacitySummary: jest.fn().mockResolvedValue(buildCapacitySummary()),
    };
    controller = new ProgramsController(
      programsService as unknown as ProgramsService,
    );
  });

  it('forwards CreateProgramDto to ProgramsService.create and returns the response DTO', async () => {
    const dto: CreateProgramDto = {
      name: 'Financing Program',
      originalCapacityAmount: '1000',
      originalCapacityCurrency: 'EUR',
      totalCapacityUsdAmount: '1100',
    };
    const program = buildProgram();
    programsService.create.mockResolvedValue(program);

    const result = await controller.create(dto);

    expect(programsService.create).toHaveBeenCalledWith(dto);
    expect(result.id).toBe(program.id);
    expect(result.availableCapacityUsd).toEqual({
      amount: '1100.0000',
      currency: 'USD',
    });
  });

  it('returns a response list from ProgramsService.list', async () => {
    const programs = [buildProgram(), buildProgram({ id: 'program-id-2' })];
    programsService.list.mockResolvedValue(programs);

    const result = await controller.list();

    expect(programsService.list).toHaveBeenCalledWith();
    expect(result).toHaveLength(2);
    expect(result.map((dto) => dto.id)).toEqual(['program-id', 'program-id-2']);
  });

  it('forwards the id param to ProgramsService.get and returns the response DTO', async () => {
    const program = buildProgram();
    programsService.get.mockResolvedValue(program);

    const result = await controller.get(program.id);

    expect(programsService.get).toHaveBeenCalledWith(program.id);
    expect(result.id).toBe(program.id);
  });

  it('forwards id and UpdateProgramDto to ProgramsService.update and returns the response DTO', async () => {
    const dto: UpdateProgramDto = { name: 'Renamed Program' };
    const program = buildProgram({ name: 'Renamed Program' });
    programsService.update.mockResolvedValue(program);

    const result = await controller.update(program.id, dto);

    expect(programsService.update).toHaveBeenCalledWith(program.id, dto);
    expect(result.name).toBe('Renamed Program');
  });

  it('forwards the id param to ProgramsService.delete', async () => {
    programsService.delete.mockResolvedValue(undefined);

    await controller.delete('program-id');

    expect(programsService.delete).toHaveBeenCalledWith('program-id');
  });

  it('never exposes internal fields beyond the response DTO contract', async () => {
    const program = buildProgram();
    programsService.get.mockResolvedValue(program);

    const result = await controller.get(program.id);

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'name',
        'originalCapacity',
        'totalCapacityUsd',
        'reservedCapacityUsd',
        'availableCapacityUsd',
        'treasuryVersion',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});
