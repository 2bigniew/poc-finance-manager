import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '@app/modules/database/types/database.interface';
import {
  subtractDecimal,
  USD_DECIMAL_SCALE,
} from '@app/modules/domain/shared/money/decimal-math';
import { CreateProgramDto } from './dto/create-program.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { InvalidProgramCapacityError } from './exceptions/invalid-program-capacity.error';
import { ProgramNotFoundError } from './exceptions/program-not-found.error';
import { Program, ProgramCapacitySummary } from './program.entity';
import { ProgramsRepository } from './programs.repository';
import {
  RESERVED_CAPACITY_PORT,
  ReservedCapacityPort,
} from './reserved-capacity.port';

// Mirrors CreateProgramDto's own format check - kept independent so the service still
// enforces the invariant (BUSINESS.md: "totalCapacityUsd >= 0") for any caller, not only
// ones that went through HTTP validation.
const NON_NEGATIVE_DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

@Injectable()
export class ProgramsService {
  private readonly logger = new Logger(ProgramsService.name);

  constructor(
    private readonly programsRepository: ProgramsRepository,
    @Inject(RESERVED_CAPACITY_PORT)
    private readonly reservedCapacityPort: ReservedCapacityPort,
  ) {}

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

  // BUSINESS.md's derived-capacity formula:
  //   reservedCapacityUsd = SUM(active Reservation.convertedMoneyUsd)
  //   availableCapacityUsd = totalCapacityUsd - reservedCapacityUsd
  // reservedCapacityUsd comes from the real, persisted, ACTIVE Reservations via
  // ReservedCapacityPort (see reserved-capacity.port.ts for why this is a port rather
  // than a direct ReservationsModule import) - never hardcoded, never persisted here.
  async getCapacitySummary(program: Program): Promise<ProgramCapacitySummary> {
    const reservedCapacityUsd =
      await this.reservedCapacityPort.sumActiveByProgram(program.id);

    return {
      reservedCapacityUsd,
      availableCapacityUsd: {
        amount: subtractDecimal(
          program.totalCapacityUsd.amount,
          reservedCapacityUsd.amount,
          USD_DECIMAL_SCALE,
        ),
        currency: 'USD',
      },
    };
  }

  // Acquires a PostgreSQL row lock via ProgramsRepository.findByIdForUpdate - exposed
  // here because ProgramsRepository is private to this module (ARCHITECTURE.md); other
  // modules' capacity-changing transactions (Reservations, and later Release) reuse this
  // exact locking method rather than re-implementing it (CLAUDE.md: "Do not reimplement
  // raw Program locking SQL in ReservationsRepository").
  async findByIdForUpdate(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Program | null> {
    return this.programsRepository.findByIdForUpdate(id, executor);
  }

  // Transaction-aware pass-through for Reconciliation's treasury-capacity replacement
  // (BUSINESS.md Bulk Reconciliation) - ProgramsRepository stays private to this module
  // (ARCHITECTURE.md), so this is how a caller-owned `trx` participates in the atomic
  // totalCapacityUsd/treasuryVersion write. Returns null on failure (the guard described
  // on ProgramsRepository.applyReconciliation) rather than throwing a
  // Reconciliation-specific error: which typed error is appropriate is the caller's
  // business decision, not this module's (Programs does not know Reconciliations
  // exists) - mirrors findByIdForUpdate/the Invoices markReserved convention.
  async applyReconciliation(
    id: string,
    fromTreasuryVersion: number,
    row: {
      totalCapacityUsdAmount: string;
      treasuryVersion: number;
      updatedAt: Date;
    },
    executor: Kysely<Database>,
  ): Promise<Program | null> {
    return this.programsRepository.applyReconciliation(
      id,
      fromTreasuryVersion,
      row,
      executor,
    );
  }

  private assertNonNegativeDecimal(value: string, fieldName: string): void {
    if (!NON_NEGATIVE_DECIMAL_PATTERN.test(value)) {
      throw new InvalidProgramCapacityError(
        `${fieldName} must be a non-negative decimal amount`,
      );
    }
  }
}
