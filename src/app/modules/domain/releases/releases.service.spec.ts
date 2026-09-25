import { Kysely } from 'kysely';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { InvoiceNotFoundError } from '@app/modules/domain/invoices/exceptions/invoice-not-found.error';
import { Invoice } from '@app/modules/domain/invoices/invoice.entity';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { Program } from '@app/modules/domain/programs/program.entity';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReservationNotFoundError } from '@app/modules/domain/reservations/exceptions/reservation-not-found.error';
import { Reservation } from '@app/modules/domain/reservations/reservation.entity';
import { ReservationsService } from '@app/modules/domain/reservations/reservations.service';
import { InvoiceNotReleasableError } from './exceptions/invoice-not-releasable.error';
import { ReleaseNotFoundError } from './exceptions/release-not-found.error';
import { ReservationNotActiveError } from './exceptions/reservation-not-active.error';
import { Release } from './release.entity';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'program-id',
    name: 'Test Program',
    originalCapacity: { amount: '1000.0000', currency: 'USD' },
    totalCapacityUsd: { amount: '1000.0000', currency: 'USD' },
    treasuryVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'invoice-id',
    externalReference: 'INV-001',
    // Deliberately DIFFERENT from the Reservation's rate below - a test in this file
    // asserts the Release never reads these Invoice values (CLAUDE.md section 30).
    originalMoney: { amount: '100', currency: 'EUR' },
    convertedMoneyUsd: { amount: '110.0000', currency: 'USD' },
    conversion: {
      original: { amount: '100', currency: 'EUR' },
      converted: { amount: '110.0000', currency: 'USD' },
      rate: '1.10',
      rateDate: new Date('2025-06-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    status: 'RESERVED',
    createdByUserId: 'invoice-owner-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'reservation-id',
    programId: 'program-id',
    invoiceId: 'invoice-id',
    originalMoney: { amount: '100', currency: 'EUR' },
    convertedMoneyUsd: { amount: '115.0000', currency: 'USD' },
    conversion: {
      original: { amount: '100', currency: 'EUR' },
      converted: { amount: '115.0000', currency: 'USD' },
      rate: '1.15',
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

function buildRelease(overrides: Partial<Release> = {}): Release {
  return {
    id: 'release-id',
    reservationId: 'reservation-id',
    invoiceId: 'invoice-id',
    programId: 'program-id',
    originalMoney: { amount: '100', currency: 'EUR' },
    convertedMoneyUsd: { amount: '115.0000', currency: 'USD' },
    conversion: {
      original: { amount: '100', currency: 'EUR' },
      converted: { amount: '115.0000', currency: 'USD' },
      rate: '1.15',
      rateDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    createdByUserId: 'caller-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// Maps the flat row `ReleasesRepository.create` is actually called with back into a
// proper `Release` entity shape - the same mapping the real
// ReleasesRepository.toEntity performs. Needed because buildReleaseCreatedEvent (called
// by ReleasesService.release AFTER the repository write) reads
// release.originalMoney/convertedMoneyUsd/conversion, so the mocked create() must
// return an entity-shaped object, not just echo its raw insert row.
function toReleaseEntity(row: Record<string, unknown>): Release {
  const original = {
    amount: row.originalAmount as string,
    currency: row.originalCurrency as string,
  };
  const converted = {
    amount: row.convertedAmountUsd as string,
    currency: 'USD',
  };

  return {
    id: row.id as string,
    reservationId: row.reservationId as string,
    invoiceId: row.invoiceId as string,
    programId: row.programId as string,
    originalMoney: original,
    convertedMoneyUsd: converted,
    conversion: {
      original,
      converted,
      rate: row.conversionRate as string,
      rateDate: row.conversionRateDate as Date,
      source: row.conversionSource as 'frankfurter.dev',
    },
    createdByUserId: row.createdByUserId as string,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

describe('ReleasesService', () => {
  let service: ReleasesService;
  let db: { transaction: jest.Mock };
  let trxMarker: { marker: 'trx' };
  let releasesRepository: {
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>, unknown]>;
    findById: jest.Mock;
    findByReservationId: jest.Mock;
  };
  let programsService: { findByIdForUpdate: jest.Mock };
  let reservationsService: {
    get: jest.Mock;
    findByIdForUpdate: jest.Mock;
    markReleased: jest.Mock;
  };
  let invoicesService: {
    findByIdForUpdate: jest.Mock;
    markRepaid: jest.Mock;
  };
  let outboxRepository: { create: jest.Mock };

  beforeEach(() => {
    trxMarker = { marker: 'trx' };
    db = {
      transaction: jest.fn().mockReturnValue({
        execute: (callback: (trx: unknown) => Promise<unknown>) =>
          callback(trxMarker),
      }),
    };
    releasesRepository = {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>, unknown]>(),
      findById: jest.fn(),
      findByReservationId: jest.fn().mockResolvedValue(null),
    };
    programsService = {
      findByIdForUpdate: jest.fn().mockResolvedValue(buildProgram()),
    };
    reservationsService = {
      get: jest.fn().mockResolvedValue(buildReservation()),
      findByIdForUpdate: jest.fn().mockResolvedValue(buildReservation()),
      markReleased: jest
        .fn()
        .mockResolvedValue(buildReservation({ status: 'RELEASED' })),
    };
    invoicesService = {
      findByIdForUpdate: jest.fn().mockResolvedValue(buildInvoice()),
      markRepaid: jest
        .fn()
        .mockResolvedValue(buildInvoice({ status: 'REPAID' })),
    };
    outboxRepository = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    service = new ReleasesService(
      db as unknown as Kysely<Database>,
      releasesRepository as unknown as ReleasesRepository,
      programsService as unknown as ProgramsService,
      reservationsService as unknown as ReservationsService,
      invoicesService as unknown as InvoicesService,
      outboxRepository as unknown as OutboxRepository,
    );
  });

  describe('release - success', () => {
    it('generates a UUID for the new release', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      const release = await service.release('reservation-id', 'caller-id');

      expect((release as unknown as { id: string }).id).toMatch(UUID_PATTERN);
    });

    it('copies originalMoney/convertedMoneyUsd/conversion EXACTLY from the Reservation, not the Invoice or any current rate', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      await service.release('reservation-id', 'caller-id');

      expect(releasesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          originalAmount: '100',
          originalCurrency: 'EUR',
          convertedAmountUsd: '115.0000',
          conversionRate: '1.15',
          conversionRateDate: new Date('2026-01-01T00:00:00.000Z'),
          conversionSource: 'frankfurter.dev',
        }),
        trxMarker,
      );
      // The Invoice's own conversion (rate 1.10) must never leak into the Release.
      const [row] = releasesRepository.create.mock.calls[0] as [
        Record<string, unknown>,
        unknown,
      ];
      expect(row.conversionRate).not.toBe('1.10');
    });

    it('never calls any FX/Frankfurter dependency - ReleasesService has no such dependency', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      // Structural proof, not a mock-and-assert-zero-calls check (CLAUDE.md section
      // 31): the constructor signature itself has no FX service parameter, so there is
      // no currencyExchangeService/frankfurterClient field on the instance at all.
      const instanceFields = Object.getOwnPropertyNames(service);
      expect(instanceFields).not.toContain('currencyExchangeService');
      expect(instanceFields).not.toContain('frankfurterClient');

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).resolves.toBeDefined();
    });

    it('sets reservationId/invoiceId/programId/createdByUserId from the locked Reservation and current caller', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      await service.release('reservation-id', 'caller-id');

      expect(releasesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: 'reservation-id',
          invoiceId: 'invoice-id',
          programId: 'program-id',
          createdByUserId: 'caller-id',
        }),
        trxMarker,
      );
    });

    it('locks the Program before locking the Reservation (lock ordering)', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );
      const callOrder: string[] = [];
      programsService.findByIdForUpdate.mockImplementation(() => {
        callOrder.push('program');
        return Promise.resolve(buildProgram());
      });
      reservationsService.findByIdForUpdate.mockImplementation(() => {
        callOrder.push('reservation');
        return Promise.resolve(buildReservation());
      });
      invoicesService.findByIdForUpdate.mockImplementation(() => {
        callOrder.push('invoice');
        return Promise.resolve(buildInvoice());
      });

      await service.release('reservation-id', 'caller-id');

      expect(callOrder).toEqual(['program', 'reservation', 'invoice']);
    });

    it('marks the Reservation RELEASED and the Invoice REPAID inside the same transaction executor', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      await service.release('reservation-id', 'caller-id');

      expect(reservationsService.markReleased).toHaveBeenCalledWith(
        'reservation-id',
        trxMarker,
      );
      expect(invoicesService.markRepaid).toHaveBeenCalledWith(
        'invoice-id',
        trxMarker,
      );
    });

    it('writes a release.created outbox row in the same transaction, keyed by programId', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      await service.release('reservation-id', 'caller-id');

      expect(outboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'releases.events',
          messageKey: 'program-id',
          eventType: 'release.created',
        }),
        trxMarker,
      );
      const [row] = outboxRepository.create.mock.calls[0] as [
        Record<string, unknown>,
        unknown,
      ];
      expect(row.eventId).toBe(row.id);
      const payload = row.payload as {
        payload: { releaseId: string; reservationId: string };
      };
      expect(payload.payload.reservationId).toBe('reservation-id');
    });

    it('does not open a transaction before the pre-read Reservation lookup', async () => {
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );
      const callOrder: string[] = [];
      reservationsService.get.mockImplementation(() => {
        callOrder.push('pre-read');
        return Promise.resolve(buildReservation());
      });
      db.transaction.mockImplementation(() => {
        callOrder.push('transaction');
        return {
          execute: (cb: (trx: unknown) => Promise<unknown>) => cb(trxMarker),
        };
      });

      await service.release('reservation-id', 'caller-id');

      expect(callOrder).toEqual(['pre-read', 'transaction']);
    });
  });

  describe('release - idempotent retry', () => {
    it('returns the existing Release when the locked Reservation is already RELEASED', async () => {
      reservationsService.findByIdForUpdate.mockResolvedValue(
        buildReservation({ status: 'RELEASED' }),
      );
      const existingRelease = buildRelease();
      releasesRepository.findByReservationId.mockResolvedValue(existingRelease);

      const result = await service.release('reservation-id', 'caller-id');

      expect(result).toBe(existingRelease);
      expect(releasesRepository.create).not.toHaveBeenCalled();
      expect(reservationsService.markReleased).not.toHaveBeenCalled();
      expect(invoicesService.markRepaid).not.toHaveBeenCalled();
      // Idempotent retry MUST NOT create a second logical outbox event (CLAUDE.md
      // "Release Workflow Review").
      expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('throws ReservationNotActiveError when the Reservation is RELEASED but no Release row exists (invariant violation)', async () => {
      reservationsService.findByIdForUpdate.mockResolvedValue(
        buildReservation({ status: 'RELEASED' }),
      );
      releasesRepository.findByReservationId.mockResolvedValue(null);

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(ReservationNotActiveError);
      expect(releasesRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('release - failures', () => {
    it('throws ReservationNotFoundError when the pre-read load fails, without starting a transaction', async () => {
      reservationsService.get.mockRejectedValue(
        new ReservationNotFoundError('reservation-id'),
      );

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(ReservationNotFoundError);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('throws ProgramNotFoundError when the locked Program does not exist', async () => {
      programsService.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(ProgramNotFoundError);
      expect(releasesRepository.create).not.toHaveBeenCalled();
    });

    it('throws ReservationNotFoundError when the locked Reservation does not exist', async () => {
      reservationsService.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(ReservationNotFoundError);
      expect(releasesRepository.create).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotFoundError when the locked Invoice does not exist', async () => {
      invoicesService.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotFoundError);
      expect(releasesRepository.create).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotReleasableError when the locked Invoice is not RESERVED', async () => {
      invoicesService.findByIdForUpdate.mockResolvedValue(
        buildInvoice({ status: 'OPEN' }),
      );

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotReleasableError);
      expect(releasesRepository.create).not.toHaveBeenCalled();
    });

    it('throws ReservationNotActiveError when marking the Reservation RELEASED unexpectedly returns null', async () => {
      reservationsService.markReleased.mockResolvedValue(null);
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(ReservationNotActiveError);
      expect(invoicesService.markRepaid).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotReleasableError when marking the Invoice REPAID unexpectedly returns null', async () => {
      invoicesService.markRepaid.mockResolvedValue(null);
      releasesRepository.create.mockImplementation((row) =>
        Promise.resolve(toReleaseEntity(row)),
      );

      await expect(
        service.release('reservation-id', 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotReleasableError);
    });
  });

  describe('get', () => {
    it('returns an existing release', async () => {
      const release = buildRelease();
      releasesRepository.findById.mockResolvedValue(release);

      await expect(service.get(release.id)).resolves.toBe(release);
    });

    it('throws ReleaseNotFoundError when missing', async () => {
      releasesRepository.findById.mockResolvedValue(null);

      await expect(service.get('missing-id')).rejects.toBeInstanceOf(
        ReleaseNotFoundError,
      );
    });
  });
});
