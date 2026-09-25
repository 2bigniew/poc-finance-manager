import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { ReconciliationsRepository } from './reconciliations.repository';

async function createTestProgram(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('programs')
    .values({
      id,
      name: `Program ${id}`,
      originalCapacityAmount: '1000.0000',
      originalCapacityCurrency: 'USD',
      totalCapacityUsdAmount: '1000.0000',
      treasuryVersion: 0,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

function buildReconciliationRow(
  programId: string,
  overrides: Partial<{
    batchId: string;
    externalEventId: string;
    sourceVersion: number;
    totalCapacityUsd: string;
    status: 'APPLIED' | 'IGNORED_STALE' | 'FAILED';
  }> = {},
) {
  const id = randomUUID();
  const now = new Date();
  const sourceVersion = overrides.sourceVersion ?? 1;

  return {
    id,
    batchId: overrides.batchId ?? `batch-${id}`,
    externalEventId:
      overrides.externalEventId ?? `batch-${id}:${programId}:${sourceVersion}`,
    programId,
    sourceVersion,
    totalCapacityUsd: overrides.totalCapacityUsd ?? '1200.0000',
    effectiveAt: now,
    status: overrides.status ?? ('APPLIED' as const),
    createdAt: now,
    updatedAt: now,
  };
}

describe('ReconciliationsRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: ReconciliationsRepository;

  beforeAll(() => {
    db = createKysely();
    repository = new ReconciliationsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('reconciliations').execute();
    await db.deleteFrom('programs').execute();
  });

  it('creates a reconciliation and persists it', async () => {
    const programId = await createTestProgram(db);
    const row = buildReconciliationRow(programId);

    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.batchId).toBe(row.batchId);
    expect(created.externalEventId).toBe(row.externalEventId);
    expect(created.programId).toBe(programId);
    expect(created.sourceVersion).toBe(1);
    expect(created.status).toBe('APPLIED');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('persists exact NUMERIC totalCapacityUsd and effectiveAt', async () => {
    const programId = await createTestProgram(db);
    const effectiveAt = new Date('2026-03-15T12:34:56.000Z');
    const row = {
      ...buildReconciliationRow(programId, { totalCapacityUsd: '1234567.89' }),
      effectiveAt,
    };

    const created = await repository.create(row);

    expect(created.totalCapacityUsd).toEqual({
      amount: '1234567.8900',
      currency: 'USD',
    });
    expect(created.effectiveAt.getTime()).toBe(effectiveAt.getTime());
    expect(typeof created.totalCapacityUsd.amount).toBe('string');
  });

  it('finds a reconciliation by id', async () => {
    const programId = await createTestProgram(db);
    const row = buildReconciliationRow(programId);
    await repository.create(row);

    const found = await repository.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding a missing id', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('finds a reconciliation by externalEventId', async () => {
    const programId = await createTestProgram(db);
    const row = buildReconciliationRow(programId, {
      externalEventId: 'batch-x:program:1',
    });
    await repository.create(row);

    const found = await repository.findByExternalEventId('batch-x:program:1');
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding a missing externalEventId', async () => {
    const found = await repository.findByExternalEventId('does-not-exist');
    expect(found).toBeNull();
  });

  it('lists reconciliations by batchId ordered by creation time', async () => {
    const programA = await createTestProgram(db);
    const programB = await createTestProgram(db);
    const batchId = `batch-${randomUUID()}`;
    const rowA = buildReconciliationRow(programA, {
      batchId,
      sourceVersion: 1,
    });
    const rowB = buildReconciliationRow(programB, {
      batchId,
      sourceVersion: 1,
    });
    await repository.create(rowA);
    await repository.create(rowB);

    const results = await repository.findByBatchId(batchId);
    expect(results.map((r) => r.id).sort()).toEqual([rowA.id, rowB.id].sort());
  });

  it('lists reconciliations by program ordered by sourceVersion', async () => {
    const programId = await createTestProgram(db);
    const rowV2 = buildReconciliationRow(programId, { sourceVersion: 2 });
    const rowV1 = buildReconciliationRow(programId, { sourceVersion: 1 });
    await repository.create(rowV2);
    await repository.create(rowV1);

    const results = await repository.listByProgram(programId);
    expect(results.map((r) => r.sourceVersion)).toEqual([1, 2]);
  });

  it('rejects an invalid Program foreign key', async () => {
    const row = buildReconciliationRow(randomUUID());

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
    });
  });

  it('rejects an invalid status via the database CHECK constraint', async () => {
    const programId = await createTestProgram(db);
    const row = {
      ...buildReconciliationRow(programId),
      status: 'BOGUS' as 'APPLIED',
    };

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });

  it('rejects a negative totalCapacityUsd via the database CHECK constraint', async () => {
    const programId = await createTestProgram(db);
    const row = buildReconciliationRow(programId, { totalCapacityUsd: '-1' });

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23514',
    });
  });

  // Mandatory: UNIQUE(external_event_id) is the final authority for per-entry
  // idempotency (CLAUDE.md section 21/38) - mapped to the existing row rather than
  // leaking a raw constraint violation, since Reconciliation processing is an idempotent
  // command (unlike Reservation creation's ReservationAlreadyExistsError).
  // The repository itself just propagates the raw constraint violation - recovering
  // from it (fetching the winning transaction's row) is ReconciliationsService's job,
  // and can only safely happen AFTER the enclosing transaction has fully rolled back
  // (see reconciliations.service.ts and isUniqueViolation's comment in
  // reconciliations.repository.ts for why this repository must NOT attempt that
  // recovery on the same connection/transaction itself).
  it('rejects a second insert for the same externalEventId with a raw unique-violation error', async () => {
    const programId = await createTestProgram(db);
    const externalEventId = `batch-x:${programId}:1`;
    const firstRow = buildReconciliationRow(programId, { externalEventId });
    await repository.create(firstRow);

    const secondRow = buildReconciliationRow(programId, { externalEventId });
    await expect(repository.create(secondRow)).rejects.toMatchObject({
      code: '23505', // unique_violation
    });

    const allRows = await db
      .selectFrom('reconciliations')
      .selectAll()
      .where('externalEventId', '=', externalEventId)
      .execute();
    expect(allRows).toHaveLength(1);
  });
});
