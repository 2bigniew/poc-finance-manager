import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { InvoiceStatus } from '@app/modules/database/types/tables/invoices.table';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { FrankfurterClient } from '@app/modules/domain/shared/money/clients/frankfurter.client';
import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import { InvoicesRepository } from '@app/modules/domain/invoices/invoices.repository';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramsRepository } from '@app/modules/domain/programs/programs.repository';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReservationsRepository } from '@app/modules/domain/reservations/reservations.repository';
import { ReservationsService } from '@app/modules/domain/reservations/reservations.service';
import { InvoiceNotReleasableError } from './exceptions/invoice-not-releasable.error';
import { ReservationNotActiveError } from './exceptions/reservation-not-active.error';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

// Builds the real service graph by hand (same "plain instantiation against real
// Postgres" pattern already used by reservations.concurrency.integration-spec.ts and
// every *.repository.integration-spec.ts in this project) - a unit of REAL classes, no
// mocks anywhere in the dependency chain that matters for correctness. USD/EUR amounts
// are inserted directly (not created through the live Reservation-creation HTTP/service
// flow), so no Frankfurter call ever happens (FrankfurterClient is instantiated but
// never invoked) - TESTING.md forbids live Frankfurter in automated tests. This also
// lets tests give the Invoice and Reservation deliberately DIFFERENT stored FX rates
// (CLAUDE.md section 30).
function buildReleasesService(db: Kysely<Database>): {
  releasesService: ReleasesService;
  releasesRepository: ReleasesRepository;
  reservationsRepository: ReservationsRepository;
  reservationsService: ReservationsService;
  invoicesService: InvoicesService;
  programsService: ProgramsService;
  outboxRepository: OutboxRepository;
} {
  const programsRepository = new ProgramsRepository(db);
  const reservationsRepository = new ReservationsRepository(db);
  const invoicesRepository = new InvoicesRepository(db);
  const releasesRepository = new ReleasesRepository(db);
  const outboxRepository = new OutboxRepository(db);
  const frankfurterClient = {} as FrankfurterClient;
  const currencyExchangeService = new CurrencyExchangeService(
    frankfurterClient,
  );
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
  const releasesService = new ReleasesService(
    db,
    releasesRepository,
    programsService,
    reservationsService,
    invoicesService,
    outboxRepository,
  );

  return {
    releasesService,
    releasesRepository,
    reservationsRepository,
    reservationsService,
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
      email: `releases-concurrency-${id}@example.test`,
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
  overrides: Partial<{ status: InvoiceStatus; conversionRate: string }> = {},
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
      conversionRate: overrides.conversionRate ?? '1.000000',
      conversionRateDate: now,
      conversionSource: 'frankfurter.dev',
      status: overrides.status ?? 'RESERVED',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

async function createTestReservation(
  db: Kysely<Database>,
  programId: string,
  invoiceId: string,
  createdByUserId: string,
  amount: string,
  overrides: Partial<{
    status: 'ACTIVE' | 'RELEASED';
    conversionRate: string;
  }> = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('reservations')
    .values({
      id,
      programId,
      invoiceId,
      originalAmount: amount,
      originalCurrency: 'USD',
      convertedAmountUsd: amount,
      conversionRate: overrides.conversionRate ?? '1.000000',
      conversionRateDate: now,
      conversionSource: 'frankfurter.dev',
      status: overrides.status ?? 'ACTIVE',
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

describe('Release capacity restoration / idempotency concurrency (Postgres integration)', () => {
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
    await db.deleteFrom('releases').execute();
    await db.deleteFrom('reservations').execute();
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
    await db.deleteFrom('programs').execute();
  });

  // CLAUDE.md section 30/45: the Release MUST use the Reservation's own stored rate
  // (1.15), never the Invoice's stored conversion (1.10) and never any "current" rate -
  // there is no current-rate fetch anywhere in this flow to begin with.
  it('restores capacity using exactly the Reservation-time USD amount, not the Invoice conversion', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '100', {
      conversionRate: '1.10',
    });
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '115.0000',
      { conversionRate: '1.15' },
    );
    const { releasesService, programsService } = buildReleasesService(db);

    const release = await releasesService.release(reservationId, userId);

    expect(release.convertedMoneyUsd.amount).toBe('115.0000');
    expect(release.conversion.rate).toBe('1.150000');

    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.reservedCapacityUsd.amount).toBe('0.0000');
    expect(summary.availableCapacityUsd.amount).toBe('100.0000');
  });

  // Mandatory duplicate-release scenario from the migration task.
  it('is idempotent under a sequential duplicate release request: one Release, capacity restored exactly once', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
    );
    const { releasesService, releasesRepository, programsService } =
      buildReleasesService(db);

    const first = await releasesService.release(reservationId, userId);

    const reservationAfterFirst = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservationAfterFirst.status).toBe('RELEASED');
    const invoiceAfterFirst = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoiceAfterFirst.status).toBe('REPAID');

    const programAfterFirst = await programsService.get(programId);
    const summaryAfterFirst =
      await programsService.getCapacitySummary(programAfterFirst);
    expect(summaryAfterFirst.reservedCapacityUsd.amount).toBe('0.0000');
    expect(summaryAfterFirst.availableCapacityUsd.amount).toBe('100.0000');

    // Retry the exact same command.
    const second = await releasesService.release(reservationId, userId);

    expect(second.id).toBe(first.id);

    const allReleases =
      await releasesRepository.findByReservationId(reservationId);
    const allReleaseRows = await db
      .selectFrom('releases')
      .selectAll()
      .where('reservationId', '=', reservationId)
      .execute();
    expect(allReleaseRows).toHaveLength(1);
    expect(allReleases?.id).toBe(first.id);

    const reservationAfterSecond = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservationAfterSecond.status).toBe('RELEASED');
    const invoiceAfterSecond = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoiceAfterSecond.status).toBe('REPAID');

    const programAfterSecond = await programsService.get(programId);
    const summaryAfterSecond =
      await programsService.getCapacitySummary(programAfterSecond);
    // Must NOT double-restore (e.g. become 180) - still exactly 100.
    expect(summaryAfterSecond.availableCapacityUsd.amount).toBe('100.0000');
    expect(summaryAfterSecond.reservedCapacityUsd.amount).toBe('0.0000');

    // The idempotent retry MUST NOT create a second logical outbox event (CLAUDE.md
    // "Release Workflow Review").
    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'release.created')
      .execute();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.eventId).toBeDefined();
  });

  // Mandatory concurrent-release scenario from the migration task: two independent,
  // genuinely overlapping transactions/connections release the same ACTIVE Reservation
  // (Promise.allSettled starts both release() calls essentially simultaneously, each
  // opening its own db.transaction() serviced from a separate physical pool connection -
  // see reservations.concurrency.integration-spec.ts for the low-level FOR UPDATE
  // locking proof this builds on).
  it('allows two concurrent release requests for the same Reservation to resolve to exactly one Release, with capacity restored exactly once', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
    );
    const { releasesService, programsService } = buildReleasesService(db);

    const [resultA, resultB] = await Promise.allSettled([
      releasesService.release(reservationId, userId),
      releasesService.release(reservationId, userId),
    ]);

    const succeeded = [resultA, resultB].filter(isFulfilled);
    // Both calls resolve successfully under the idempotent design (CLAUDE.md section
    // 17): the Program row lock fully serializes the two transactions (both lock
    // Program first), so whichever runs second only ever observes the first one's
    // already-committed RELEASED Reservation and returns its Release row - it never
    // reaches a state where it would need to error.
    expect(succeeded).toHaveLength(2);
    const releaseIds = new Set(succeeded.map((r) => r.value.id));
    expect(releaseIds.size).toBe(1);

    const allReleaseRows = await db
      .selectFrom('releases')
      .selectAll()
      .where('reservationId', '=', reservationId)
      .execute();
    expect(allReleaseRows).toHaveLength(1);

    const reservation = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('RELEASED');
    const invoice = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('REPAID');

    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.reservedCapacityUsd.amount).toBe('0.0000');
    expect(summary.availableCapacityUsd.amount).toBe('100.0000');
  });

  // Program-level lock interaction: releasing one Reservation and creating another
  // Reservation on the SAME Program concurrently must serialize through the Program row
  // - the final state must correspond to a valid serial execution order, never an
  // oversubscribed or under-restored capacity value.
  it('serializes a concurrent Release and a new Reservation on the same Program through the Program lock', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceToRelease = await createTestInvoice(db, userId, '80');
    const reservationToRelease = await createTestReservation(
      db,
      programId,
      invoiceToRelease,
      userId,
      '80.0000',
    );
    // Deliberately small enough (10) to fit within the capacity available BEFORE the
    // release commits (total 100 - active 80 = 20 already available) - this keeps the
    // outcome deterministic regardless of which operation wins the race for the Program
    // lock, while still proving genuine serialization (not a global mutex): if a larger
    // amount were used, one of the two valid serial orderings would legitimately reject
    // the new Reservation for insufficient capacity, which is also correct but would
    // make this assertion order-dependent.
    const invoiceToReserve = await createTestInvoice(db, userId, '10', {
      status: 'OPEN',
    });
    const { releasesService, reservationsService, programsService } =
      buildReleasesService(db);

    const [releaseResult, reservationResult] = await Promise.allSettled([
      releasesService.release(reservationToRelease, userId),
      reservationsService.create(
        programId,
        { invoiceId: invoiceToReserve },
        userId,
      ),
    ]);

    expect(releaseResult.status).toBe('fulfilled');
    expect(reservationResult.status).toBe('fulfilled');

    // Whichever order they serialized in, the only valid final state is: the released
    // 80 is gone, the newly reserved 10 remains active -> reserved = 10, available = 90.
    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.reservedCapacityUsd.amount).toBe('10.0000');
    expect(summary.availableCapacityUsd.amount).toBe('90.0000');
  });

  it('rejects releasing a Reservation whose Invoice is not RESERVED', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80', {
      status: 'OPEN',
    });
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
    );
    const { releasesService } = buildReleasesService(db);

    await expect(
      releasesService.release(reservationId, userId),
    ).rejects.toBeInstanceOf(InvoiceNotReleasableError);
  });

  // Failure injected after the Release insert but before the transaction completes -
  // proves real PostgreSQL rollback atomicity, not mocked behavior: everything written
  // inside the transaction (the Release row, the Reservation status) is rolled back
  // together with the Invoice update that never got to commit.
  it('rolls back the Release insert and Reservation status change when the Invoice update fails inside the same transaction', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
    );
    const { releasesService, invoicesService, releasesRepository } =
      buildReleasesService(db);

    const markRepaidSpy = jest
      .spyOn(invoicesService, 'markRepaid')
      .mockImplementationOnce(() => {
        throw new Error('simulated failure after Release insert');
      });

    await expect(
      releasesService.release(reservationId, userId),
    ).rejects.toThrow('simulated failure after Release insert');
    markRepaidSpy.mockRestore();

    const release = await releasesRepository.findByReservationId(reservationId);
    expect(release).toBeNull();

    const reservation = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('ACTIVE');

    const invoice = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('RESERVED');

    // Capacity must still reflect the un-released Reservation.
    const { programsService } = buildReleasesService(db);
    const program = await programsService.get(programId);
    const summary = await programsService.getCapacitySummary(program);
    expect(summary.reservedCapacityUsd.amount).toBe('80.0000');

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'release.created')
      .execute();
    expect(outboxRows).toHaveLength(0);
  });

  // Mandatory (CLAUDE.md section 52), same reasoning as the equivalent Reservation
  // test: the failure is injected AFTER the real outbox INSERT has run, proving the
  // insert itself rolls back together with the rest of the Release transaction rather
  // than merely never being reached.
  it('rolls back the outbox insert together with the Release when a later step fails (outbox atomicity)', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
    );
    const { releasesService, releasesRepository, outboxRepository } =
      buildReleasesService(db);

    const realCreate = outboxRepository.create.bind(outboxRepository);
    const outboxSpy = jest
      .spyOn(outboxRepository, 'create')
      .mockImplementationOnce(async (row, executor) => {
        await realCreate(row, executor);
        throw new Error('simulated failure after outbox insert');
      });

    await expect(
      releasesService.release(reservationId, userId),
    ).rejects.toThrow('simulated failure after outbox insert');
    outboxSpy.mockRestore();

    const release = await releasesRepository.findByReservationId(reservationId);
    expect(release).toBeNull();

    const reservation = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('ACTIVE');

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'release.created')
      .execute();
    expect(outboxRows).toHaveLength(0);
  });

  it('writes exactly one release.created outbox row on a successful Release', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80');
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
    );
    const { releasesService } = buildReleasesService(db);

    const release = await releasesService.release(reservationId, userId);

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'release.created')
      .execute();
    expect(outboxRows).toHaveLength(1);
    const outboxRow = outboxRows[0];
    expect(outboxRow?.topic).toBe('releases.events');
    expect(outboxRow?.messageKey).toBe(programId);
    expect(outboxRow?.publishedAt).toBeNull();
    const payload = outboxRow?.payload as {
      payload: { releaseId: string };
    };
    expect(payload.payload.releaseId).toBe(release.id);
  });

  it('throws ReservationNotActiveError when releasing a Reservation that is RELEASED with no Release row (data corruption, not a retry)', async () => {
    const programId = await createTestProgram(db, '100');
    const invoiceId = await createTestInvoice(db, userId, '80', {
      status: 'REPAID',
    });
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '80.0000',
      { status: 'RELEASED' },
    );
    const { releasesService } = buildReleasesService(db);

    await expect(
      releasesService.release(reservationId, userId),
    ).rejects.toBeInstanceOf(ReservationNotActiveError);
  });
});
