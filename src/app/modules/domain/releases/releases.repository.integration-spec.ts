import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { ReleasesRepository } from './releases.repository';

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `releases-repo-test-${id}@example.test`,
      passwordHash: 'hashed-password-placeholder',
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

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

async function createTestInvoice(
  db: Kysely<Database>,
  createdByUserId: string,
  overrides: Partial<{ status: 'OPEN' | 'RESERVED' | 'REPAID' }> = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('invoices')
    .values({
      id,
      externalReference: `INV-${id}`,
      originalAmount: '80.0000',
      originalCurrency: 'USD',
      convertedAmountUsd: '80.0000',
      conversionRate: '1.000000',
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
  overrides: Partial<{
    status: 'ACTIVE' | 'RELEASED';
    convertedAmountUsd: string;
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
      originalAmount: '80.0000',
      originalCurrency: 'USD',
      convertedAmountUsd: overrides.convertedAmountUsd ?? '80.0000',
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

function buildReleaseRow(
  reservationId: string,
  invoiceId: string,
  programId: string,
  createdByUserId: string,
  overrides: Partial<{
    convertedAmountUsd: string;
    conversionRate: string;
  }> = {},
) {
  const id = randomUUID();
  const now = new Date();

  return {
    id,
    reservationId,
    invoiceId,
    programId,
    originalAmount: '80.0000',
    originalCurrency: 'USD',
    convertedAmountUsd: overrides.convertedAmountUsd ?? '80.0000',
    conversionRate: overrides.conversionRate ?? '1.000000',
    conversionRateDate: now,
    conversionSource: 'frankfurter.dev' as const,
    createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ReleasesRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: ReleasesRepository;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    repository = new ReleasesRepository(db);
    userId = await createTestUser(db);
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('releases').execute();
    await db.deleteFrom('reservations').execute();
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
    await db.deleteFrom('programs').execute();
  });

  it('creates a release and persists it', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(reservationId, invoiceId, programId, userId);

    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.reservationId).toBe(reservationId);
    expect(created.invoiceId).toBe(invoiceId);
    expect(created.programId).toBe(programId);
    expect(created.createdByUserId).toBe(userId);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('persists exact original money, converted USD, rate, rate date, and source', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(reservationId, invoiceId, programId, userId, {
      convertedAmountUsd: '1234567.89',
      conversionRate: '4.123456',
    });

    const created = await repository.create(row);

    expect(created.originalMoney).toEqual({
      amount: '80.0000',
      currency: 'USD',
    });
    expect(created.convertedMoneyUsd.amount).toBe('1234567.8900');
    expect(created.conversion.rate).toBe('4.123456');
    expect(created.conversion.rateDate.getTime()).toBe(
      row.conversionRateDate.getTime(),
    );
    expect(created.conversion.source).toBe('frankfurter.dev');
    expect(typeof created.convertedMoneyUsd.amount).toBe('string');
  });

  it('finds a release by id', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(reservationId, invoiceId, programId, userId);
    await repository.create(row);

    const found = await repository.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding a missing id', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('finds a release by reservation id', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(reservationId, invoiceId, programId, userId);
    await repository.create(row);

    const found = await repository.findByReservationId(reservationId);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when the reservation has no release', async () => {
    const found = await repository.findByReservationId(randomUUID());
    expect(found).toBeNull();
  });

  it('rejects an invalid Reservation foreign key', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReleaseRow(randomUUID(), invoiceId, programId, userId);

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
    });
  });

  it('rejects an invalid Invoice foreign key', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(reservationId, randomUUID(), programId, userId);

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('rejects an invalid Program foreign key', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(reservationId, invoiceId, randomUUID(), userId);

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('rejects an invalid User (createdByUserId) foreign key', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const row = buildReleaseRow(
      reservationId,
      invoiceId,
      programId,
      randomUUID(),
    );

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503',
    });
  });

  // Mandatory: the database's UNIQUE(reservation_id) constraint (0007_create_releases_
  // table.ts) is the final authority ("A Reservation MUST NOT be released twice" -
  // BUSINESS.md). Unlike ReservationsRepository.create (which maps its own unique
  // violation to an error), this maps the race to the EXISTING Release row - Release is
  // an idempotent command (CLAUDE.md section 16-17).
  it('resolves a second insert for the same reservation to the existing Release row, not an error', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const reservationId = await createTestReservation(
      db,
      programId,
      invoiceId,
      userId,
    );
    const firstRow = buildReleaseRow(
      reservationId,
      invoiceId,
      programId,
      userId,
    );
    const first = await repository.create(firstRow);

    const secondRow = buildReleaseRow(
      reservationId,
      invoiceId,
      programId,
      userId,
    );
    const second = await repository.create(secondRow);

    expect(second.id).toBe(first.id);

    const allReleases = await db
      .selectFrom('releases')
      .selectAll()
      .where('reservationId', '=', reservationId)
      .execute();
    expect(allReleases).toHaveLength(1);
  });
});
