import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Money } from '@app/modules/domain/shared/money/money';
import { CreateProgramDto } from './dto/create-program.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { InvalidProgramCapacityError } from './exceptions/invalid-program-capacity.error';
import { ProgramNotFoundError } from './exceptions/program-not-found.error';
import { Program, ProgramCapacitySummary } from './program.entity';
import { ProgramsRepository } from './programs.repository';

// Mirrors CreateProgramDto's own format check - kept independent so the service still
// enforces the invariant (BUSINESS.md: "totalCapacityUsd >= 0") for any caller, not only
// ones that went through HTTP validation.
const NON_NEGATIVE_DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

const ZERO_USD: Money = { amount: '0.0000', currency: 'USD' };

@Injectable()
export class ProgramsService {
  private readonly logger = new Logger(ProgramsService.name);

  constructor(private readonly programsRepository: ProgramsRepository) {}

  async create(dto: CreateProgramDto): Promise<Program> {
    this.assertNonNegativeDecimal(
      dto.originalCapacityAmount,
      'originalCapacityAmount',
    );
    this.assertNonNegativeDecimal(
      dto.totalCapacityUsdAmount,
      'totalCapacityUsdAmount',
    );

    const now = new Date();
    const program = await this.programsRepository.create({
      id: randomUUID(),
      name: dto.name,
      originalCapacityAmount: dto.originalCapacityAmount,
      originalCapacityCurrency: dto.originalCapacityCurrency,
      totalCapacityUsdAmount: dto.totalCapacityUsdAmount,
      // Treasury-owned capacity starts at version 0; only the future reconciliation flow
      // advances it (BUSINESS.md: "Treasury owns Program total capacity").
      treasuryVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log(`Program created: ${program.id}`);
    return program;
  }

  async get(id: string): Promise<Program> {
    const program = await this.programsRepository.findById(id);
    if (!program) {
      throw new ProgramNotFoundError(id);
    }

    return program;
  }

  async list(): Promise<Program[]> {
    return this.programsRepository.list();
  }

  async update(id: string, dto: UpdateProgramDto): Promise<Program> {
    const patch: { name?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (dto.name !== undefined) {
      patch.name = dto.name;
    }

    const updated = await this.programsRepository.update(id, patch);
    if (!updated) {
      throw new ProgramNotFoundError(id);
    }

    this.logger.log(`Program updated: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.programsRepository.delete(id);
    if (!deleted) {
      throw new ProgramNotFoundError(id);
    }

    this.logger.log(`Program deleted: ${id}`);
  }

  // Reservations are not implemented yet (CLAUDE.md Explicit Non-Goals). This is the
  // seam BUSINESS.md's derived-capacity formula plugs into later:
  //   reservedCapacityUsd = SUM(active Reservation.convertedMoneyUsd)
  //   availableCapacityUsd = totalCapacityUsd - reservedCapacityUsd
  // Kept async (even though currently synchronous internally) so this becomes a real
  // ReservationsRepository sum query later without changing any caller's code
  // (controllers/DTOs keep their current shape).
  getCapacitySummary(program: Program): Promise<ProgramCapacitySummary> {
    return Promise.resolve({
      reservedCapacityUsd: ZERO_USD,
      availableCapacityUsd: program.totalCapacityUsd,
    });
  }

  private assertNonNegativeDecimal(value: string, fieldName: string): void {
    if (!NON_NEGATIVE_DECIMAL_PATTERN.test(value)) {
      throw new InvalidProgramCapacityError(
        `${fieldName} must be a non-negative decimal amount`,
      );
    }
  }
}
