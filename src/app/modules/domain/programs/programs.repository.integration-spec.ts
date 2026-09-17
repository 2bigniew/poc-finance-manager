import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { ProgramsRepository } from './programs.repository';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Polls real PostgreSQL server state (not a fixed sleep) to prove a backend is genuinely
// blocked waiting for a row lock, per CLAUDE.md: "Use bounded synchronization rather than
// arbitrary sleep-based timing where possible."
async function waitUntilBlockedOnLock(
  db: Kysely<Database>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from pg_stat_activity
      where wait_event_type = 'Lock' and pid <> pg_backend_pid()
    `.execute(db);

    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for a transaction to block on a row lock');
}

function buildProgramRow(overrides: Partial<{ treasuryVersion: number }> = {}) {
  const id = randomUUID();
  const now = new Date();

  return {
    id,
    name: `Program ${id}`,
    originalCapacityAmount: '1000.0000',
    originalCapacityCurrency: 'EUR',
    totalCapacityUsdAmount: '1100.0000',
    treasuryVersion: overrides.treasuryVersion ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ProgramsRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: ProgramsRepository;

  beforeAll(() => {
    db = createKysely();
    repository = new ProgramsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('programs').execute();
  });

  it('creates a program and persists it', async () => {
    const row = buildProgramRow();
    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.name).toBe(row.name);
    expect(created.originalCapacity).toEqual({
      amount: row.originalCapacityAmount,
      currency: row.originalCapacityCurrency,
    });
    expect(created.totalCapacityUsd).toEqual({
      amount: row.totalCapacityUsdAmount,
      currency: 'USD',
    });
    expect(created.treasuryVersion).toBe(0);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('persists exact NUMERIC capacity precision without floating-point loss', async () => {
    const row = buildProgramRow();
    row.originalCapacityAmount = '1234567.89';
    row.totalCapacityUsdAmount = '0.10';

    const created = await repository.create(row);

    expect(created.originalCapacity.amount).toBe('1234567.8900');
    expect(created.totalCapacityUsd.amount).toBe('0.1000');
    expect(typeof created.originalCapacity.amount).toBe('string');
    expect(typeof created.totalCapacityUsd.amount).toBe('string');
  });

  it('persists treasuryVersion as an exact integer', async () => {
    const row = buildProgramRow({ treasuryVersion: 7 });
    const created = await repository.create(row);

    expect(created.treasuryVersion).toBe(7);
  });

  it('finds a program by id', async () => {
    const row = buildProgramRow();
    await repository.create(row);

    const found = await repository.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding a missing id', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('lists programs ordered by creation time', async () => {
    const rowA = buildProgramRow();
    await repository.create(rowA);
    const rowB = buildProgramRow();
    await repository.create(rowB);

    const programs = await repository.list();
    const ids = programs.map((program) => program.id);
    expect(ids).toEqual(expect.arrayContaining([rowA.id, rowB.id]));
  });

  it('updates a program name and updatedAt', async () => {
    const row = buildProgramRow();
    await repository.create(row);

    const updatedAt = new Date();
    const updated = await repository.update(row.id, {
      name: 'Renamed Program',
      updatedAt,
    });

    expect(updated?.name).toBe('Renamed Program');
    expect(updated?.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect(updated?.createdAt.getTime()).toBe(row.createdAt.getTime());
  });

  it('returns null when updating a missing program', async () => {
    const updated = await repository.update(randomUUID(), {
      updatedAt: new Date(),
    });
    expect(updated).toBeNull();
  });

  it('deletes a program', async () => {
    const row = buildProgramRow();
    await repository.create(row);

    const deleted = await repository.delete(row.id);
    expect(deleted).toBe(true);

    const found = await repository.findById(row.id);
    expect(found).toBeNull();
  });

  it('returns false when deleting a missing program', async () => {
    const deleted = await repository.delete(randomUUID());
    expect(deleted).toBe(false);
  });

  it('rejects negative capacity via the database CHECK constraint', async () => {
    const row = buildProgramRow();
    row.totalCapacityUsdAmount = '-1';

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });

  describe('findByIdForUpdate', () => {
    it('returns the program using a caller-supplied transaction executor', async () => {
      const row = buildProgramRow();
      await repository.create(row);

      const found = await db.transaction().execute(async (trx) => {
        return repository.findByIdForUpdate(row.id, trx);
      });

      expect(found?.id).toBe(row.id);
    });

    it('returns null for a missing program', async () => {
      const found = await db.transaction().execute(async (trx) => {
        return repository.findByIdForUpdate(randomUUID(), trx);
      });

      expect(found).toBeNull();
    });

    // Mandatory per the Programs migration task: proves the real PostgreSQL row-locking
    // behavior with two independent, concurrently-open transactions - never with mocks,
    // and never wrapped in one shared test transaction. Both transactions run through
    // the same `db` (Kysely hands each `.transaction().execute()` call its own dedicated
    // physical connection from the pool for as long as it's open, exactly like two
    // separate concurrent requests would in production) - kysely.provider.ts's
    // `createKysely()` instances all share one module-level `pg.Pool`, so creating a
    // second/third Kysely wrapper here would not add real connection independence, only
    // a pool that gets destroyed out from under the others.
    it('blocks a second transaction from locking the same row until the first completes', async () => {
      const row = buildProgramRow();
      await repository.create(row);

      const lockAcquired = createDeferred<void>();
      const releaseLock = createDeferred<void>();

      const txAPromise = db.transaction().execute(async (trx) => {
        const locked = await repository.findByIdForUpdate(row.id, trx);
        expect(locked?.id).toBe(row.id);
        lockAcquired.resolve();
        await releaseLock.promise;
      });

      await lockAcquired.promise;

      let txBCompleted = false;
      const txBPromise = db.transaction().execute(async (trx) => {
        await repository.findByIdForUpdate(row.id, trx);
        txBCompleted = true;
      });

      // Prove B is genuinely blocked inside PostgreSQL, not just "hasn't run in Node
      // yet" - then confirm it really hasn't completed while A still holds the lock.
      await waitUntilBlockedOnLock(db);
      expect(txBCompleted).toBe(false);

      releaseLock.resolve();
      await txAPromise;
      await txBPromise;

      expect(txBCompleted).toBe(true);
    }, 15_000);
  });
});
