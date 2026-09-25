import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { ProgramsRepository } from '@app/modules/domain/programs/programs.repository';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';
import { ReconciliationsRepository } from './reconciliations.repository';
import { ReconciliationsService } from './reconciliations.service';
import { ReconciliationProcessingError } from './exceptions/reconciliation-processing.error';

const ENVELOPE = {
  topic: 'treasury.reconciliation',
  partition: 0,
  offset: '0',
};

// Builds the real service graph by hand (same "plain instantiation against real
// Postgres" pattern used by every *.repository.integration-spec.ts and the Reservations/
// Releases concurrency specs in this project) - a unit of REAL classes, no mocks
// anywhere in the dependency chain that matters for correctness.
function buildReconciliationsService(db: Kysely<Database>): {
  reconciliationsService: ReconciliationsService;
  reconciliationsRepository: ReconciliationsRepository;
  reconciliationEventsRepository: ReconciliationEventsRepository;
  programsService: ProgramsService;
  reservationsRepository: ReservationsRepositoryLike;
  outboxRepository: OutboxRepository;
} {
  const programsRepository = new ProgramsRepository(db);
  const reconciliationsRepository = new ReconciliationsRepository(db);
  const reconciliationEventsRepository = new ReconciliationEventsRepository(db);
  const outboxRepository = new OutboxRepository(db);
  // ReservedCapacityPort's real production implementation lives in
  // ReservationsRepository; only sumActiveByProgram is needed for ProgramsService's
  // capacity view, so a minimal structurally-compatible stand-in is used here rather
  // than pulling in the entire Reservations module graph for this file.
  const reservationsRepository: ReservationsRepositoryLike = {
    sumActiveByProgram: async (programId: string) => {
      const result = await db
        .selectFrom('reservations')
        .select((eb) =>
          eb.fn
            .coalesce(eb.fn.sum<string>('convertedAmountUsd'), eb.val('0.0000'))
            .as('total'),
        )
        .where('programId', '=', programId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirstOrThrow();
      return { amount: result.total, currency: 'USD' };
    },
  };
  const programsService = new ProgramsService(
    programsRepository,
    reservationsRepository,
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
    reconciliationsRepository,
    reconciliationEventsRepository,
    programsService,
    reservationsRepository,
    outboxRepository,
  };
}

interface ReservationsRepositoryLike {
  sumActiveByProgram: (
    programId: string,
  ) => Promise<{ amount: string; currency: string }>;
}

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `reconciliations-test-${id}@example.test`,
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
      status: 'RESERVED',
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
      conversionRate: '1.000000',
      conversionRateDate: now,
      conversionSource: 'frankfurter.dev',
      status: 'ACTIVE',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

describe('ReconciliationsService Postgres integration', () => {
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

  // Mandatory (CLAUDE.md "Reconciliation Workflow Review" / "Reconciliation Event
  // Contract"): a successfully APPLIED entry writes exactly one reconciliation.applied
  // outbox row, atomically with the Program/Reconciliation update; an IGNORED_STALE
  // entry writes none.
  it('writes a reconciliation.applied outbox row for an APPLIED entry, keyed by programId, and none for IGNORED_STALE', async () => {
    const programId = await createTestProgram(db, '1000', 10);
    const { reconciliationsService } = buildReconciliationsService(db);

    const applied = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 11,
        totalCapacityUsd: '1200.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    const appliedOutboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'reconciliation.applied')
      .execute();
    expect(appliedOutboxRows).toHaveLength(1);
    const appliedRow = appliedOutboxRows[0];
    expect(appliedRow?.topic).toBe('reconciliations.events');
    expect(appliedRow?.messageKey).toBe(programId);
    expect(appliedRow?.publishedAt).toBeNull();
    const payload = appliedRow?.payload as {
      payload: { reconciliationId: string; totalCapacityUsd: unknown };
    };
    expect(payload.payload.reconciliationId).toBe(applied.id);
    expect(payload.payload.totalCapacityUsd).toEqual({
      amount: '1200.0000',
      currency: 'USD',
    });

    // A stale/duplicate replay of the same Program must not add a second event.
    await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 5,
        totalCapacityUsd: '1.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    const allOutboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'reconciliation.applied')
      .execute();
    expect(allOutboxRows).toHaveLength(1);
  });

  // Mandatory (CLAUDE.md section 52), same reasoning as the equivalent Reservation/
  // Release tests: the failure is injected AFTER the real outbox INSERT has run,
  // proving the insert itself rolls back together with the rest of the reconciliation
  // transaction.
  it('rolls back the outbox insert together with the Reconciliation when a later step fails (outbox atomicity)', async () => {
    const programId = await createTestProgram(db, '1000', 10);
    const { reconciliationsService, outboxRepository, programsService } =
      buildReconciliationsService(db);

    const realCreate = outboxRepository.create.bind(outboxRepository);
    const outboxSpy = jest
      .spyOn(outboxRepository, 'create')
      .mockImplementationOnce(async (row, executor) => {
        await realCreate(row, executor);
        throw new Error('simulated failure after outbox insert');
      });

    await expect(
      reconciliationsService.reconcileProgramEntry(
        {
          batchId: 'batch-1',
          programId,
          sourceVersion: 11,
          totalCapacityUsd: '1200.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        ENVELOPE,
      ),
    ).rejects.toThrow('simulated failure after outbox insert');
    outboxSpy.mockRestore();

    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('1000.0000');
    expect(program.treasuryVersion).toBe(10);

    const outboxRows = await db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('eventType', '=', 'reconciliation.applied')
      .execute();
    expect(outboxRows).toHaveLength(0);
    const reconciliationRows = await db
      .selectFrom('reconciliations')
      .selectAll()
      .where('programId', '=', programId)
      .execute();
    expect(reconciliationRows).toHaveLength(0);
  });

  // BUSINESS.md Bulk Reconciliation: "incoming sourceVersion > treasuryVersion ->
  // replace treasury-owned totalCapacityUsd, set treasuryVersion".
  it('applies a newer snapshot: replaces (not increments) totalCapacityUsd and treasuryVersion', async () => {
    const programId = await createTestProgram(db, '1000', 10);
    const { reconciliationsService, programsService } =
      buildReconciliationsService(db);

    const result = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 11,
        totalCapacityUsd: '1200.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    expect(result.status).toBe('APPLIED');

    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('1200.0000');
    expect(program.treasuryVersion).toBe(11);
  });

  it('ignores a stale (older) snapshot and leaves Program state untouched', async () => {
    const programId = await createTestProgram(db, '1000', 15);
    const { reconciliationsService, programsService } =
      buildReconciliationsService(db);

    const result = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 14,
        totalCapacityUsd: '500.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    expect(result.status).toBe('IGNORED_STALE');

    const program = await programsService.get(programId);
    // Mandatory scenario (CLAUDE.md section 30): must NOT roll back to 500.
    expect(program.totalCapacityUsd.amount).toBe('1000.0000');
    expect(program.treasuryVersion).toBe(15);
  });

  it('ignores a duplicate (equal-version) snapshot with no business effect', async () => {
    const programId = await createTestProgram(db, '1000', 12);
    const { reconciliationsService, programsService } =
      buildReconciliationsService(db);

    const result = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 12,
        totalCapacityUsd: '999.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    expect(result.status).toBe('IGNORED_STALE');

    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('1000.0000');
    expect(program.treasuryVersion).toBe(12);
  });

  // Mandatory scenario (CLAUDE.md section 31): an authoritative snapshot repairs a gap
  // and subsumes the missing earlier versions.
  it('accepts a newer snapshot that skips versions (gap) and repairs it - earlier missing versions become stale', async () => {
    const programId = await createTestProgram(db, '1000', 10);
    const { reconciliationsService, programsService } =
      buildReconciliationsService(db);

    const result = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 13,
        totalCapacityUsd: '1500.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    expect(result.status).toBe('APPLIED');
    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('1500.0000');
    expect(program.treasuryVersion).toBe(13);

    // A later-arriving "missing" version 11 or 12 must now be rejected as stale - it is
    // subsumed by the already-applied snapshot 13, never replayed on top of it.
    const replay = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-2',
        programId,
        sourceVersion: 11,
        totalCapacityUsd: '1100.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );
    expect(replay.status).toBe('IGNORED_STALE');
    const programAfterReplay = await programsService.get(programId);
    expect(programAfterReplay.totalCapacityUsd.amount).toBe('1500.0000');
    expect(programAfterReplay.treasuryVersion).toBe(13);
  });

  // CLAUDE.md section 29: unknown Program is a typed processing failure, not silently
  // ignored/created.
  it('throws ProgramNotFoundError for an unknown Program and writes nothing', async () => {
    const { reconciliationsService, reconciliationsRepository } =
      buildReconciliationsService(db);
    const unknownProgramId = randomUUID();

    await expect(
      reconciliationsService.reconcileProgramEntry(
        {
          batchId: 'batch-1',
          programId: unknownProgramId,
          sourceVersion: 1,
          totalCapacityUsd: '100.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        ENVELOPE,
      ),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);

    const rows =
      await reconciliationsRepository.listByProgram(unknownProgramId);
    expect(rows).toHaveLength(0);
  });

  // CLAUDE.md section 6/32/47: Reservations/Releases/Invoices are never touched by
  // reconciliation.
  it('leaves an ACTIVE Reservation completely untouched (id, status, money, FX, createdBy)', async () => {
    const programId = await createTestProgram(db, '1000', 5);
    const invoiceId = await createTestInvoice(db, userId, '400');
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
      '400.0000',
    );
    const before = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();

    const { reconciliationsService } = buildReconciliationsService(db);
    await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 6,
        totalCapacityUsd: '2000.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    const after = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();

    expect(after).toEqual(before);
    expect(after.status).toBe('ACTIVE');
  });

  // CLAUDE.md section 48: capacity view is fully derived, no Reservation row changes.
  it('capacity view reflects the new total while reserved capacity stays derived from unchanged ACTIVE Reservations', async () => {
    const programId = await createTestProgram(db, '1000', 3);
    const invoiceA = await createTestInvoice(db, userId, '300');
    const invoiceB = await createTestInvoice(db, userId, '200');
    await createTestReservation(db, programId, invoiceA, userId, '300.0000');
    await createTestReservation(db, programId, invoiceB, userId, '200.0000');

    const { reconciliationsService, programsService } =
      buildReconciliationsService(db);

    const programBefore = await programsService.get(programId);
    const summaryBefore =
      await programsService.getCapacitySummary(programBefore);
    expect(summaryBefore.reservedCapacityUsd.amount).toBe('500.0000');
    expect(summaryBefore.availableCapacityUsd.amount).toBe('500.0000');

    await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 4,
        totalCapacityUsd: '1400.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    const programAfter = await programsService.get(programId);
    const summaryAfter = await programsService.getCapacitySummary(programAfter);
    expect(summaryAfter.reservedCapacityUsd.amount).toBe('500.0000');
    expect(summaryAfter.availableCapacityUsd.amount).toBe('900.0000');
  });

  // UNRESOLVED BUSINESS DECISION (flagged per CLAUDE.md section 33's explicit
  // instruction rather than silently invented): CLAUDE.md's Domain Essentials states
  // unconditionally "Available capacity MUST NOT become negative", but the Bulk
  // Reconciliation rules (BUSINESS.md / CLAUDE.md Reconciliation section) describe pure
  // replacement of totalCapacityUsd with no validation against currently-reserved
  // capacity, and CLAUDE.md section 33 of this task explicitly forbids inventing a new
  // overcommit policy (deleting/resizing Reservations, clamping, etc.) to reconcile the
  // two. This test documents the CURRENT, actual, unresolved consequence: the Program
  // row itself updates exactly as documented (proving reconciliation's write path is
  // correct), but reading capacity afterward hits decimal-math.ts's existing
  // subtractDecimal, which throws RangeError for a negative result rather than
  // returning a wrong number - so GET /programs/:id becomes unusable for this Program
  // until an explicit policy decision is made. See the final summary for the
  // recommendation to resolve this at the project level.
  it('[documents an unresolved gap] applies a lower total than currently reserved - Program updates correctly, but capacity reads then throw', async () => {
    const programId = await createTestProgram(db, '1000', 1);
    const invoiceId = await createTestInvoice(db, userId, '700');
    await createTestReservation(db, programId, invoiceId, userId, '700.0000');

    const { reconciliationsService, programsService } =
      buildReconciliationsService(db);

    const result = await reconciliationsService.reconcileProgramEntry(
      {
        batchId: 'batch-1',
        programId,
        sourceVersion: 2,
        totalCapacityUsd: '600.0000',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      ENVELOPE,
    );

    // The reconciliation write itself succeeds and is recorded exactly as received -
    // reconciliation does not reject/validate against currently-reserved capacity
    // (no such rule exists in BUSINESS.md's Bulk Reconciliation section).
    expect(result.status).toBe('APPLIED');
    expect(result.totalCapacityUsd.amount).toBe('600.0000');
    const program = await programsService.get(programId);
    expect(program.totalCapacityUsd.amount).toBe('600.0000');

    // No Reservation was deleted/resized/released to force availability back to a
    // valid number (CLAUDE.md section 33 - explicitly forbidden).
    const reservation = await db
      .selectFrom('reservations')
      .selectAll()
      .where('programId', '=', programId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.convertedAmountUsd).toBe('700.0000');

    // Documented current behavior: the derived capacity read throws rather than
    // silently returning a negative or clamped value.
    await expect(
      programsService.getCapacitySummary(program),
    ).rejects.toBeInstanceOf(RangeError);
  });

  describe('reconcileBulk - per-entry independence and partial failure', () => {
    it('processes each Program entry independently and atomically - one failure does not roll back others', async () => {
      const programA = await createTestProgram(db, '1000', 0);
      const programC = await createTestProgram(db, '1000', 0);
      const unknownProgramB = randomUUID();
      const { reconciliationsService, programsService } =
        buildReconciliationsService(db);

      await expect(
        reconciliationsService.reconcileBulk(
          {
            batchId: 'batch-partial',
            entries: [
              {
                batchId: 'batch-partial',
                programId: programA,
                sourceVersion: 1,
                totalCapacityUsd: '1100.0000',
                effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
              },
              {
                batchId: 'batch-partial',
                programId: unknownProgramB,
                sourceVersion: 1,
                totalCapacityUsd: '900.0000',
                effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
              },
              {
                batchId: 'batch-partial',
                programId: programC,
                sourceVersion: 1,
                totalCapacityUsd: '1300.0000',
                effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          },
          ENVELOPE,
        ),
      ).rejects.toBeInstanceOf(ReconciliationProcessingError);

      // A and C committed independently despite B failing.
      const a = await programsService.get(programA);
      expect(a.totalCapacityUsd.amount).toBe('1100.0000');
      const c = await programsService.get(programC);
      expect(c.totalCapacityUsd.amount).toBe('1300.0000');
    });

    // Mandatory bulk-retry scenario (CLAUDE.md section 22/42): retrying the same
    // message after a partial failure must not re-apply already-committed entries.
    it('retrying the same bulk message after a partial failure only re-applies the failed entry (per-entry idempotency)', async () => {
      const programA = await createTestProgram(db, '1000', 0);
      const programC = await createTestProgram(db, '1000', 0);
      const programB = await createTestProgram(db, '1000', 0);
      const { reconciliationsService, programsService } =
        buildReconciliationsService(db);

      const entries = [
        {
          batchId: 'batch-retry',
          programId: programA,
          sourceVersion: 1,
          totalCapacityUsd: '1100.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          batchId: 'batch-retry',
          programId: programB,
          sourceVersion: 1,
          totalCapacityUsd: '900.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          batchId: 'batch-retry',
          programId: programC,
          sourceVersion: 1,
          totalCapacityUsd: '1300.0000',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];

      // First attempt: force B to fail with a transient error (not "Program missing"),
      // so a plain retry can succeed the second time - A and C use the real
      // implementation and commit normally.
      const originalApply =
        programsService.applyReconciliation.bind(programsService);
      const firstAttemptSpy = jest
        .spyOn(programsService, 'applyReconciliation')
        .mockImplementation((programId, fromVersion, patch, executor) => {
          if (programId === programB) {
            throw new Error('simulated transient failure for program B');
          }
          return originalApply(programId, fromVersion, patch, executor);
        });

      await expect(
        reconciliationsService.reconcileBulk(
          { batchId: 'batch-retry', entries },
          ENVELOPE,
        ),
      ).rejects.toBeInstanceOf(ReconciliationProcessingError);
      firstAttemptSpy.mockRestore();

      const aAfterFirst = await programsService.get(programA);
      expect(aAfterFirst.totalCapacityUsd.amount).toBe('1100.0000');
      const bAfterFirst = await programsService.get(programB);
      expect(bAfterFirst.totalCapacityUsd.amount).toBe('1000.0000'); // unchanged
      const cAfterFirst = await programsService.get(programC);
      expect(cAfterFirst.totalCapacityUsd.amount).toBe('1300.0000');

      // Second attempt: same message, B now succeeds for real. Track which programs
      // actually reach applyReconciliation - A and C must NOT reach it again, since
      // their per-entry dedup should short-circuit before the Program lock is even
      // taken.
      const applyCallsOnRetry: string[] = [];
      const retrySpy = jest
        .spyOn(programsService, 'applyReconciliation')
        .mockImplementation((programId, fromVersion, patch, executor) => {
          applyCallsOnRetry.push(programId);
          return originalApply(programId, fromVersion, patch, executor);
        });

      await reconciliationsService.reconcileBulk(
        { batchId: 'batch-retry', entries },
        ENVELOPE,
      );
      retrySpy.mockRestore();

      expect(applyCallsOnRetry).toEqual([programB]);

      const aFinal = await programsService.get(programA);
      expect(aFinal.totalCapacityUsd.amount).toBe('1100.0000');
      const bFinal = await programsService.get(programB);
      expect(bFinal.totalCapacityUsd.amount).toBe('900.0000');
      const cFinal = await programsService.get(programC);
      expect(cFinal.totalCapacityUsd.amount).toBe('1300.0000');
    });
  });
});
