import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { InvoiceStatus } from '@app/modules/database/types/tables/invoices.table';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { InvoicesRepository } from '@app/modules/domain/invoices/invoices.repository';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramsRepository } from '@app/modules/domain/programs/programs.repository';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import { FrankfurterClient } from '@app/modules/domain/shared/money/clients/frankfurter.client';
import { InsufficientCapacityError } from './exceptions/insufficient-capacity.error';
import { InvoiceNotReservableError } from './exceptions/invoice-not-reservable.error';
import { ReservationAlreadyExistsError } from './exceptions/reservation-already-exists.error';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

// Builds the real service graph by hand (same "plain instantiation against real
// Postgres" pattern already used by every *.repository.integration-spec.ts in this
// project), rather than a full NestJS TestingModule - this is a unit of REAL classes,
// no mocks anywhere in the dependency chain that matters for correctness. USD is used
// throughout so CurrencyExchangeService's USD->USD shortcut never calls Frankfurter
// (FrankfurterClient is instantiated but never invoked) - TESTING.md forbids live
// Frankfurter in automated tests.
function buildReservationsService(db: Kysely<Database>): {
  reservationsService: ReservationsService;
  reservationsRepository: ReservationsRepository;
  invoicesService: InvoicesService;
  programsService: ProgramsService;
  outboxRepository: OutboxRepository;
} {
  const programsRepository = new ProgramsRepository(db);
  const reservationsRepository = new ReservationsRepository(db);
  const invoicesRepository = new InvoicesRepository(db);
  const outboxRepository = new OutboxRepository(db);
  const frankfurterClient = {} as FrankfurterClient;
  const currencyExchangeService = new CurrencyExchangeService(
    frankfurterClient,
  );
  // ReservationsRepository structurally satisfies ReservedCapacityPort (same
  // production wiring as ReservedCapacityPortModule - see that file).
  const programsService = new ProgramsService(
    programsRepository,
    reservationsRepository,
  );
  const invoicesService = new InvoicesService(
    invoicesRepository,
    currencyExchangeService,
  );
  const reservationsService = new ReservationsService(
    db,
    reservationsRepository,
    programsService,
    invoicesService,
    currencyExchangeService,
    outboxRepository,
  );

  return {
    reservationsService,
    reservationsRepository,
    invoicesService,
    programsService,
    outboxRepository,
  };
}

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `reservations-concurrency-${id}@example.test`,
      passwordHash: 'hashed-password-placeholder',
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

async function createTestProgram(
  db: Kysely<Database>,
  totalCapacityUsdAmount: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('programs')
    .values({
      id,
      name: `Program ${id}`,
      originalCapacityAmount: totalCapacityUsdAmount,
      originalCapacityCurrency: 'USD',
      totalCapacityUsdAmount,
      treasuryVersion: 0,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

async function createTestInvoice(
  db: Kysely<Database>,
  createdByUserId: string,
  amount: string,
  overrides: Partial<{ status: InvoiceStatus }> = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('invoices')
    .values({
      id,
      externalReference: `INV-${id}`,
      originalAmount: amount,
      originalCurrency: 'USD',
      convertedAmountUsd: amount,
      conversionRate: '1.000000',
      conversionRateDate: now,
      conversionSource: 'frankfurter.dev',
      status: overrides.status ?? 'OPEN',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

function isFulfilled<T>(
  result: PromiseSettledResult<T>,
): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled';
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

describe('Reservation capacity concurrency (Postgres integration)', () => {
  let db: Kysely<Database>;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    userId = await createTestUser(db);
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('outboxEvents').execute();
    await db.deleteFrom('reservations').execute();
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
    await db.deleteFrom('programs').execute();
  });

  // Mandatory per the migration task. Proves the core invariant - "Reservation creation
  // MUST NEVER oversubscribe Program capacity" - under two independent, genuinely
  // overlapping transactions/connections (Promise.allSettled starts both `create()`
  // calls essentially simultaneously; each opens its own db.transaction(), which Kysely
  // services from a separate physical pool connection - see
  // programs.repository.integration-spec.ts's dedicated findByIdForUpdate locking test
  // for the low-level proof that the row lock itself blocks a second transaction; this
  // suite builds on that primitive to prove the higher-level business outcome).
  it('allows exactly one of two conflicting concurrent reservations to succeed, never oversubscribing capacity', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceA = await createTestInvoice(db, userId, '80');
    const invoiceB = await createTestInvoice(db, userId, '80');
    const { reservationsService, reservationsRepository, programsService } =
      buildReservationsService(db);

    const [resultA, resultB] = await Promise.allSettled([
      reservationsService.create(programId, { invoiceId: invoiceA }, userId),
      reservationsService.create(programId, { invoiceId: invoiceB }, userId),
    ]);

    const succeeded = [resultA, resultB].filter(isFulfilled);
    const failed = [resultA, resultB].filter(isRejected);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(InsufficientCapacityError);

    const activeReservations = (
      await reservationsRepository.listByProgram(programId)
    ).filter((r) => r.status === 'ACTIVE');
    expect(activeReservations).toHaveLength(1);
    expect(activeReservations[0]?.convertedMoneyUsd.amount).toBe('80.0000');

    const reservedSum =
      await reservationsRepository.sumActiveByProgram(programId);
    expect(reservedSum.amount).toBe('80.0000');

    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.reservedCapacityUsd.amount).toBe('80.0000');
    expect(summary.availableCapacityUsd.amount).toBe('20.0000');
  });

  it('allows two non-conflicting concurrent reservations to both succeed', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceA = await createTestInvoice(db, userId, '40');
    const invoiceB = await createTestInvoice(db, userId, '40');
    const { reservationsService, reservationsRepository, programsService } =
      buildReservationsService(db);

    const [resultA, resultB] = await Promise.allSettled([
      reservationsService.create(programId, { invoiceId: invoiceA }, userId),
      reservationsService.create(programId, { invoiceId: invoiceB }, userId),
    ]);

    expect([resultA, resultB].filter(isFulfilled)).toHaveLength(2);

    const reservedSum =
      await reservationsRepository.sumActiveByProgram(programId);
    expect(reservedSum.amount).toBe('80.0000');

    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.availableCapacityUsd.amount).toBe('20.0000');
  });

  it('allows a reservation for exactly the remaining capacity, then rejects any further reservation', async () => {
    const programId = await createTestProgram(db, '100');
    const { reservationsService, reservationsRepository, programsService } =
      buildReservationsService(db);

    const existingInvoice = await createTestInvoice(db, userId, '20');
    await reservationsService.create(
      programId,
      { invoiceId: existingInvoice },
      userId,
    );

    const boundaryInvoice = await createTestInvoice(db, userId, '80');
    const reservation = await reservationsService.create(
      programId,
      { invoiceId: boundaryInvoice },
      userId,
    );
    expect(reservation.convertedMoneyUsd.amount).toBe('80.0000');

    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.availableCapacityUsd.amount).toBe('0.0000');

    const overflowInvoice = await createTestInvoice(db, userId, '1');
    await expect(
      reservationsService.create(
        programId,
        { invoiceId: overflowInvoice },
        userId,
      ),
    ).rejects.toBeInstanceOf(InsufficientCapacityError);

    const reservedSum =
      await reservationsRepository.sumActiveByProgram(programId);
    expect(reservedSum.amount).toBe('100.0000');
  });

  // Program-row locking is scoped to a single row (`WHERE id = ?` under FOR UPDATE), so
  // by construction there is no application-level global mutex anywhere in this
  // implementation (no Mutex/Redis lock/shared in-memory lock object) - different
  // Programs' rows are never contended against each other. This test verifies the
  // functional outcome (both succeed when run concurrently against different Programs).
  it('does not serialize unrelated Programs through a global lock', async () => {
    const programA = await createTestProgram(db, '100');
    const programB = await createTestProgram(db, '100');
    const invoiceA = await createTestInvoice(db, userId, '50');
    const invoiceB = await createTestInvoice(db, userId, '50');
    const { reservationsService } = buildReservationsService(db);

    const [resultA, resultB] = await Promise.allSettled([
      reservationsService.create(programA, { invoiceId: invoiceA }, userId),
      reservationsService.create(programB, { invoiceId: invoiceB }, userId),
    ]);

    expect([resultA, resultB].filter(isFulfilled)).toHaveLength(2);
  });

  // Two concurrent attempts to reserve the SAME Invoice. The Invoice row lock
  // (invoicesService.findByIdForUpdate inside the transaction) serializes this
  // deterministically via revalidation in this codebase's lock ordering (Program then
  // Invoice), but the DB's partial unique index is an equally valid final backstop
  // (CLAUDE.md section 44: "fail safely through: Invoice state revalidation or partial
  // unique constraint") - either is accepted so this test does not overfit to exact
  // interleaving timing.
  it('allows at most one ACTIVE reservation when the same Invoice is reserved concurrently', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const { reservationsService, reservationsRepository } =
      buildReservationsService(db);

    const [resultA, resultB] = await Promise.allSettled([
      reservationsService.create(programId, { invoiceId }, userId),
      reservationsService.create(programId, { invoiceId }, userId),
    ]);

    const succeeded = [resultA, resultB].filter(isFulfilled);
    const failed = [resultA, resultB].filter(isRejected);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(
      failed[0]?.reason instanceof InvoiceNotReservableError ||
        failed[0]?.reason instanceof ReservationAlreadyExistsError,
    ).toBe(true);

    const active =
      await reservationsRepository.findActiveByInvoiceId(invoiceId);
    expect(active).not.toBeNull();

    const allForInvoice = (
      await reservationsRepository.listByProgram(programId)
    ).filter((r) => r.invoiceId === invoiceId);
    expect(allForInvoice.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
  });

  // Failure injected after the Reservation insert but before the transaction completes
  // (CLAUDE.md section 45 explicitly endorses this failure-injection boundary) - proves
  // real PostgreSQL rollback atomicity, not mocked behavior: everything written inside
  // the transaction (the Reservation row) is rolled back together with the Invoice
  // update that never got to commit.
  it('rolls back the Reservation insert when the Invoice update fails inside the same transaction', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const { reservationsService, reservationsRepository, invoicesService } =
      buildReservationsService(db);

    const markReservedSpy = jest
      .spyOn(invoicesService, 'markReserved')
      .mockImplementationOnce(() => {
        throw new Error('simulated failure after Reservation insert');
      });

    await expect(
      reservationsService.create(programId, { invoiceId }, userId),
    ).rejects.toThrow('simulated failure after Reservation insert');
    markReservedSpy.mockRestore();

    const reservations = (
      await reservationsRepository.listByProgram(programId)
    ).filter((r) => r.invoiceId === invoiceId);
    expect(reservations).toHaveLength(0);

    const invoice = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('OPEN');

    const reservedSum =
      await reservationsRepository.sumActiveByProgram(programId);
    expect(reservedSum.amount).toBe('0.0000');

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'reservation.created')
      .execute();
    expect(outboxRows).toHaveLength(0);
  });

  // Mandatory (CLAUDE.md section 52): the outbox insert commits or rolls back together
  // with the rest of the Reservation transaction - the publisher never has to guess
  // whether a row it can see corresponds to committed business state. The failure is
  // injected AFTER the real outbox INSERT has run (unlike the test above, which fails
  // before the outbox write is even reached) to prove the insert itself is rolled back,
  // not merely skipped.
  it('rolls back the outbox insert together with the Reservation when a later step fails (outbox atomicity)', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const { reservationsService, reservationsRepository, outboxRepository } =
      buildReservationsService(db);

    const realCreate = outboxRepository.create.bind(outboxRepository);
    const outboxSpy = jest
      .spyOn(outboxRepository, 'create')
      .mockImplementationOnce(async (row, executor) => {
        await realCreate(row, executor);
        throw new Error('simulated failure after outbox insert');
      });

    await expect(
      reservationsService.create(programId, { invoiceId }, userId),
    ).rejects.toThrow('simulated failure after outbox insert');
    outboxSpy.mockRestore();

    const reservations = (
      await reservationsRepository.listByProgram(programId)
    ).filter((r) => r.invoiceId === invoiceId);
    expect(reservations).toHaveLength(0);

    const invoice = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('OPEN');

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'reservation.created')
      .execute();
    expect(outboxRows).toHaveLength(0);
  });

  it('writes exactly one reservation.created outbox row on a successful Reservation', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const { reservationsService } = buildReservationsService(db);

    const reservation = await reservationsService.create(
      programId,
      { invoiceId },
      userId,
    );

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'reservation.created')
      .execute();
    expect(outboxRows).toHaveLength(1);
    const outboxRow = outboxRows[0];
    expect(outboxRow?.topic).toBe('reservations.events');
    expect(outboxRow?.messageKey).toBe(programId);
    expect(outboxRow?.publishedAt).toBeNull();
    const payload = outboxRow?.payload as {
      eventId: string;
      payload: { reservationId: string };
    };
    expect(payload.eventId).toBe(outboxRow?.eventId);
    expect(payload.payload.reservationId).toBe(reservation.id);
  });
});
