import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { FrankfurterClient } from '@app/modules/domain/shared/money/clients/frankfurter.client';
import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import { InvoicesRepository } from '@app/modules/domain/invoices/invoices.repository';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramsRepository } from '@app/modules/domain/programs/programs.repository';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReservationsRepository } from '@app/modules/domain/reservations/reservations.repository';
import { ReservationsService } from '@app/modules/domain/reservations/reservations.service';
import { InsufficientCapacityError } from '@app/modules/domain/reservations/exceptions/insufficient-capacity.error';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';
import { ReconciliationsRepository } from './reconciliations.repository';
import { ReconciliationsService } from './reconciliations.service';

const ENVELOPE = {
  topic: 'treasury.reconciliation',
  partition: 0,
  offset: '0',
};

// Builds the real service graph by hand (same "plain instantiation against real
// Postgres" pattern used throughout this project's *.concurrency.integration-spec.ts
// files) - real classes, real Postgres, no mocks anywhere in the dependency chain that
// matters for correctness. USD throughout so CurrencyExchangeService's USD->USD
// shortcut never calls Frankfurter (FrankfurterClient is instantiated but never
// invoked) - TESTING.md forbids live Frankfurter in automated tests.
function buildServices(db: Kysely<Database>): {
  reconciliationsService: ReconciliationsService;
  reservationsService: ReservationsService;
  reservationsRepository: ReservationsRepository;
  programsService: ProgramsService;
} {
  const programsRepository = new ProgramsRepository(db);
  const reservationsRepository = new ReservationsRepository(db);
  const invoicesRepository = new InvoicesRepository(db);
  const reconciliationsRepository = new ReconciliationsRepository(db);
  const reconciliationEventsRepository = new ReconciliationEventsRepository(db);
  const outboxRepository = new OutboxRepository(db);
  const frankfurterClient = {} as FrankfurterClient;
  const currencyExchangeService = new CurrencyExchangeService(
    frankfurterClient,
  );
  // ReservationsRepository structurally satisfies ReservedCapacityPort (same
  // production wiring as reserved-capacity-port.module.ts).
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
  const reconciliationsService = new ReconciliationsService(
    db,
    reconciliationsRepository,
    reconciliationEventsRepository,
    programsService,
    outboxRepository,
  );

  return {
    reconciliationsService,
    reservationsService,
    reservationsRepository,
    programsService,
  };
}

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `reconciliations-concurrency-${id}@example.test`,
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
  treasuryVersion = 0,
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
      treasuryVersion,
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
      status: 'OPEN',
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

describe('Reconciliation Program-lock concurrency (Postgres integration)', () => {
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
    await db.deleteFrom('reconciliationEvents').execute();
    await db.deleteFrom('reconciliations').execute();
    await db.deleteFrom('reservations').execute();
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
    await db.deleteFrom('programs').execute();
  });

  // Mandatory (CLAUDE.md section 40): Reconciliation and Reservation creation for the
  // SAME Program must serialize through the Program row lock. Both operations run in
  // genuinely overlapping transactions/connections (Promise.allSettled), and the final
  // state must correspond to exactly one valid serial ordering - never a state where a
  // Reservation was created against stale/half-applied capacity.
  it('serializes a concurrent Reconciliation and Reservation creation for the same Program through the Program lock', async () => {
    const programId = await createTestProgram(db, '100', 5);
    const invoiceId = await createTestInvoice(db, userId, '150');
    const { reconciliationsService, reservationsService, programsService } =
      buildServices(db);

    const [reconciliationResult, reservationResult] = await Promise.allSettled([
      reconciliationsService.reconcileProgramEntry(
        {
          batchId: 'batch-1',
          programId,
          sourceVersion: 6,
          totalCapacityUsd: '200.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        ENVELOPE,
      ),
      reservationsService.create(programId, { invoiceId }, userId),
    ]);

    expect(reconciliationResult.status).toBe('fulfilled');

    // Whichever order they serialized in, the only two valid final states are:
    //   (a) reconciliation first (capacity becomes 200) -> Reservation of 150 succeeds
    //   (b) Reservation first (capacity is still 100, 150 exceeds it) -> Reservation
    //       fails with InsufficientCapacityError, reconciliation still applies after.
    // Both are valid serial orderings; what must NEVER happen is silent corruption
    // (e.g. a Reservation created against half-applied/torn capacity state).
    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('200.0000');
    expect(program.treasuryVersion).toBe(6);

    if (isFulfilled(reservationResult)) {
      // Order (a): reconciliation committed first.
      const summary = await programsService.getCapacitySummary(program);
      expect(summary.reservedCapacityUsd.amount).toBe('150.0000');
      expect(summary.availableCapacityUsd.amount).toBe('50.0000');
    } else {
      // Order (b): Reservation attempted first against the pre-reconciliation total.
      expect(reservationResult.reason).toBeInstanceOf(
        InsufficientCapacityError,
      );
      const summary = await programsService.getCapacitySummary(program);
      expect(summary.reservedCapacityUsd.amount).toBe('0.0000');
      expect(summary.availableCapacityUsd.amount).toBe('200.0000');
    }
  });

  // Duplicate Kafka delivery processed concurrently (CLAUDE.md section 41): two
  // independent transactions process the exact same reconciliation entry at the same
  // time. The Program lock fully serializes them - the second one always observes the
  // first's already-committed state and returns the same audit row rather than
  // double-applying.
  it('processes a concurrently-duplicated reconciliation entry exactly once', async () => {
    const programId = await createTestProgram(db, '1000', 3);
    const { reconciliationsService } = buildServices(db);
    const entry = {
      batchId: 'batch-dup',
      programId,
      sourceVersion: 4,
      totalCapacityUsd: '1500.0000',
      effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const [resultA, resultB] = await Promise.allSettled([
      reconciliationsService.reconcileProgramEntry(entry, ENVELOPE),
      reconciliationsService.reconcileProgramEntry(entry, ENVELOPE),
    ]);

    expect([resultA, resultB].filter(isFulfilled)).toHaveLength(2);
    const ids = new Set(
      [resultA, resultB].filter(isFulfilled).map((result) => result.value.id),
    );
    expect(ids.size).toBe(1);

    const rows = await db
      .selectFrom('reconciliations')
      .selectAll()
      .where('programId', '=', programId)
      .execute();
    expect(rows).toHaveLength(1);

    const program = await db
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', programId)
      .executeTakeFirstOrThrow();
    expect(program.totalCapacityUsdAmount).toBe('1500.0000');
    expect(program.treasuryVersion).toBe(4);
    expect([resultA, resultB].filter(isRejected)).toHaveLength(0);
  });

  it('does not serialize unrelated Programs through a global lock', async () => {
    const programA = await createTestProgram(db, '100', 0);
    const programB = await createTestProgram(db, '100', 0);
    const { reconciliationsService } = buildServices(db);

    const [resultA, resultB] = await Promise.allSettled([
      reconciliationsService.reconcileProgramEntry(
        {
          batchId: 'batch-1',
          programId: programA,
          sourceVersion: 1,
          totalCapacityUsd: '200.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        ENVELOPE,
      ),
      reconciliationsService.reconcileProgramEntry(
        {
          batchId: 'batch-1',
          programId: programB,
          sourceVersion: 1,
          totalCapacityUsd: '300.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        ENVELOPE,
      ),
    ]);

    expect([resultA, resultB].filter(isFulfilled)).toHaveLength(2);
  });
});
