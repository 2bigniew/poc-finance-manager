import { Kysely } from 'kysely';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { InvoiceNotFoundError } from '@app/modules/domain/invoices/exceptions/invoice-not-found.error';
import { Invoice } from '@app/modules/domain/invoices/invoice.entity';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { Program } from '@app/modules/domain/programs/program.entity';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import { MoneyConversion } from '@app/modules/domain/shared/money/money-conversion';
import { InsufficientCapacityError } from './exceptions/insufficient-capacity.error';
import { InvoiceNotReservableError } from './exceptions/invoice-not-reservable.error';
import { ReservationAlreadyExistsError } from './exceptions/reservation-already-exists.error';
import { ReservationNotFoundError } from './exceptions/reservation-not-found.error';
import { Reservation } from './reservation.entity';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'program-id',
    name: 'Test Program',
    originalCapacity: { amount: '1000.0000', currency: 'USD' },
    totalCapacityUsd: { amount: '100.0000', currency: 'USD' },
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
    originalMoney: { amount: '80.0000', currency: 'USD' },
    convertedMoneyUsd: { amount: '80.0000', currency: 'USD' },
    conversion: {
      original: { amount: '80.0000', currency: 'USD' },
      converted: { amount: '80.0000', currency: 'USD' },
      rate: '1',
      rateDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    status: 'OPEN',
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

// Maps the flat row `ReservationsRepository.create` is actually called with back into a
// proper `Reservation` entity shape - the same mapping the real
// ReservationsRepository.toEntity performs. Needed because
// buildReservationCreatedEvent (called by ReservationsService.create AFTER the
// repository write) reads reservation.originalMoney/convertedMoneyUsd/conversion, so the
// mocked create() must return an entity-shaped object, not just echo its raw insert row.
function toReservationEntity(row: Record<string, unknown>): Reservation {
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
    programId: row.programId as string,
    invoiceId: row.invoiceId as string,
    originalMoney: original,
    convertedMoneyUsd: converted,
    conversion: {
      original,
      converted,
      rate: row.conversionRate as string,
      rateDate: row.conversionRateDate as Date,
      source: row.conversionSource as 'frankfurter.dev',
    },
    status: row.status as Reservation['status'],
    createdByUserId: row.createdByUserId as string,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

function buildConversion(
  overrides: Partial<MoneyConversion> = {},
): MoneyConversion {
  return {
    original: { amount: '80.0000', currency: 'USD' },
    converted: { amount: '80.0000', currency: 'USD' },
    rate: '1',
    rateDate: new Date('2026-01-01T00:00:00.000Z'),
    source: 'frankfurter.dev',
    ...overrides,
  };
}

describe('ReservationsService', () => {
  let service: ReservationsService;
  let db: { transaction: jest.Mock };
  let trxMarker: { marker: 'trx' };
  let reservationsRepository: {
    sumActiveByProgram: jest.Mock;
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>, unknown]>;
    findById: jest.Mock;
  };
  let programsService: { findByIdForUpdate: jest.Mock };
  let invoicesService: {
    get: jest.Mock;
    findByIdForUpdate: jest.Mock;
    markReserved: jest.Mock;
  };
  let currencyExchangeService: { convertToUsd: jest.Mock };
  let outboxRepository: { create: jest.Mock };

  beforeEach(() => {
    trxMarker = { marker: 'trx' };
    db = {
      transaction: jest.fn().mockReturnValue({
        execute: (callback: (trx: unknown) => Promise<unknown>) =>
          callback(trxMarker),
      }),
    };
    reservationsRepository = {
      sumActiveByProgram: jest
        .fn()
        .mockResolvedValue({ amount: '0.0000', currency: 'USD' }),
      create: jest.fn<Promise<unknown>, [Record<string, unknown>, unknown]>(),
      findById: jest.fn(),
    };
    programsService = {
      findByIdForUpdate: jest.fn().mockResolvedValue(buildProgram()),
    };
    invoicesService = {
      get: jest.fn().mockResolvedValue(buildInvoice()),
      findByIdForUpdate: jest.fn().mockResolvedValue(buildInvoice()),
      markReserved: jest
        .fn()
        .mockResolvedValue(buildInvoice({ status: 'RESERVED' })),
    };
    currencyExchangeService = {
      convertToUsd: jest.fn().mockResolvedValue(buildConversion()),
    };
    outboxRepository = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    service = new ReservationsService(
      db as unknown as Kysely<Database>,
      reservationsRepository as unknown as ReservationsRepository,
      programsService as unknown as ProgramsService,
      invoicesService as unknown as InvoicesService,
      currencyExchangeService as unknown as CurrencyExchangeService,
      outboxRepository as unknown as OutboxRepository,
    );
  });

  describe('create - success', () => {
    it('generates a UUID for the new reservation', async () => {
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      const reservation = await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect((reservation as unknown as { id: string }).id).toMatch(
        UUID_PATTERN,
      );
    });

    it('creates the reservation as ACTIVE with the caller as createdByUserId', async () => {
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(reservationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ACTIVE',
          createdByUserId: 'caller-id',
          programId: 'program-id',
          invoiceId: 'invoice-id',
        }),
        trxMarker,
      );
    });

    it('persists the Reservation-time FX conversion, not the Invoice-time conversion', async () => {
      currencyExchangeService.convertToUsd.mockResolvedValue(
        buildConversion({
          rate: '1.25',
          converted: { amount: '100.0000', currency: 'USD' },
        }),
      );
      programsService.findByIdForUpdate.mockResolvedValue(
        buildProgram({ totalCapacityUsd: { amount: '1000', currency: 'USD' } }),
      );
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(reservationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conversionRate: '1.25',
          convertedAmountUsd: '100.0000',
        }),
        trxMarker,
      );
    });

    it('converts the Invoice original money, using its own FX snapshot', async () => {
      const invoice = buildInvoice({
        originalMoney: { amount: '50', currency: 'EUR' },
      });
      invoicesService.get.mockResolvedValue(invoice);
      invoicesService.findByIdForUpdate.mockResolvedValue(invoice);
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(currencyExchangeService.convertToUsd).toHaveBeenCalledWith({
        amount: '50',
        currency: 'EUR',
      });
    });

    it('locks the Program before locking the Invoice (lock ordering)', async () => {
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );
      const callOrder: string[] = [];
      programsService.findByIdForUpdate.mockImplementation(() => {
        callOrder.push('program');
        return Promise.resolve(buildProgram());
      });
      invoicesService.findByIdForUpdate.mockImplementation(() => {
        callOrder.push('invoice');
        return Promise.resolve(buildInvoice());
      });

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(callOrder).toEqual(['program', 'invoice']);
    });

    it('marks the Invoice RESERVED inside the same transaction executor', async () => {
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(invoicesService.markReserved).toHaveBeenCalledWith(
        'invoice-id',
        trxMarker,
      );
    });

    it('performs the FX conversion before opening the transaction', async () => {
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );
      const callOrder: string[] = [];
      currencyExchangeService.convertToUsd.mockImplementation(() => {
        callOrder.push('fx');
        return Promise.resolve(buildConversion());
      });
      db.transaction.mockImplementation(() => {
        callOrder.push('transaction');
        return {
          execute: (cb: (trx: unknown) => Promise<unknown>) => cb(trxMarker),
        };
      });

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(callOrder).toEqual(['fx', 'transaction']);
    });

    it('writes a reservation.created outbox row in the same transaction, keyed by programId', async () => {
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      await service.create(
        'program-id',
        { invoiceId: 'invoice-id' },
        'caller-id',
      );

      expect(outboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'reservations.events',
          messageKey: 'program-id',
          eventType: 'reservation.created',
        }),
        trxMarker,
      );
      const [row] = outboxRepository.create.mock.calls[0] as [
        Record<string, unknown>,
        unknown,
      ];
      expect(row.eventId).toMatch(UUID_PATTERN);
      expect(row.id).toBe(row.eventId);
      const payload = row.payload as {
        eventId: string;
        payload: { reservationId: string; programId: string };
      };
      expect(payload.eventId).toBe(row.eventId);
      expect(payload.payload.programId).toBe('program-id');
    });

    it('allows a reservation exactly equal to remaining available capacity', async () => {
      programsService.findByIdForUpdate.mockResolvedValue(
        buildProgram({
          totalCapacityUsd: { amount: '100.0000', currency: 'USD' },
        }),
      );
      reservationsRepository.sumActiveByProgram.mockResolvedValue({
        amount: '20.0000',
        currency: 'USD',
      });
      currencyExchangeService.convertToUsd.mockResolvedValue(
        buildConversion({ converted: { amount: '80.0000', currency: 'USD' } }),
      );
      reservationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReservationEntity(row)),
      );

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).resolves.toBeDefined();
    });
  });

  describe('create - failures', () => {
    it('throws InvoiceNotFoundError when the pre-check load fails, without starting a transaction', async () => {
      invoicesService.get.mockRejectedValue(
        new InvoiceNotFoundError('invoice-id'),
      );

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotFoundError);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotReservableError when the Invoice is not OPEN (pre-check)', async () => {
      invoicesService.get.mockResolvedValue(
        buildInvoice({ status: 'RESERVED' }),
      );

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotReservableError);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(currencyExchangeService.convertToUsd).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotReservableError when the Invoice is REPAID (pre-check)', async () => {
      invoicesService.get.mockResolvedValue(buildInvoice({ status: 'REPAID' }));

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotReservableError);
    });

    it('propagates FX conversion failures without starting a transaction', async () => {
      const fxError = new Error('fx unavailable');
      currencyExchangeService.convertToUsd.mockRejectedValue(fxError);

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBe(fxError);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('throws ProgramNotFoundError when the locked Program does not exist', async () => {
      programsService.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(ProgramNotFoundError);
      expect(reservationsRepository.create).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotFoundError when the locked Invoice does not exist', async () => {
      invoicesService.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotFoundError);
      expect(reservationsRepository.create).not.toHaveBeenCalled();
    });

    it('throws InvoiceNotReservableError when the locked Invoice is no longer OPEN (revalidation)', async () => {
      invoicesService.findByIdForUpdate.mockResolvedValue(
        buildInvoice({ status: 'RESERVED' }),
      );

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(InvoiceNotReservableError);
      expect(reservationsRepository.create).not.toHaveBeenCalled();
    });

    it('throws InsufficientCapacityError when the request exceeds available capacity', async () => {
      programsService.findByIdForUpdate.mockResolvedValue(
        buildProgram({
          totalCapacityUsd: { amount: '100.0000', currency: 'USD' },
        }),
      );
      reservationsRepository.sumActiveByProgram.mockResolvedValue({
        amount: '20.0000',
        currency: 'USD',
      });
      currencyExchangeService.convertToUsd.mockResolvedValue(
        buildConversion({ converted: { amount: '80.01', currency: 'USD' } }),
      );

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBeInstanceOf(InsufficientCapacityError);
      expect(reservationsRepository.create).not.toHaveBeenCalled();
      expect(invoicesService.markReserved).not.toHaveBeenCalled();
    });

    it('propagates ReservationAlreadyExistsError from the repository (DB constraint conflict mapping)', async () => {
      const conflict = new ReservationAlreadyExistsError('invoice-id');
      reservationsRepository.create.mockRejectedValue(conflict);

      await expect(
        service.create('program-id', { invoiceId: 'invoice-id' }, 'caller-id'),
      ).rejects.toBe(conflict);
      expect(invoicesService.markReserved).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns an existing reservation', async () => {
      const reservation = buildReservation();
      reservationsRepository.findById.mockResolvedValue(reservation);

      await expect(service.get(reservation.id)).resolves.toBe(reservation);
    });

    it('throws ReservationNotFoundError when missing', async () => {
      reservationsRepository.findById.mockResolvedValue(null);

      await expect(service.get('missing-id')).rejects.toBeInstanceOf(
        ReservationNotFoundError,
      );
    });
  });
});
