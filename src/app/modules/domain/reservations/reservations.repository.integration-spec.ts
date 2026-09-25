import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { ReservationAlreadyExistsError } from './exceptions/reservation-already-exists.error';
import { ReservationsRepository } from './reservations.repository';

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `reservations-repo-test-${id}@example.test`,
      passwordHash: 'hashed-password-placeholder',
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

async function createTestProgram(
  db: Kysely<Database>,
  totalCapacityUsdAmount = '1000.0000',
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
      status: overrides.status ?? 'OPEN',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

function buildReservationRow(
  programId: string,
  invoiceId: string,
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
    programId,
    invoiceId,
    originalAmount: '80.0000',
    originalCurrency: 'USD',
    convertedAmountUsd: overrides.convertedAmountUsd ?? '80.0000',
    conversionRate: overrides.conversionRate ?? '1.000000',
    conversionRateDate: now,
    conversionSource: 'frankfurter.dev' as const,
    status: 'ACTIVE' as const,
    createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ReservationsRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: ReservationsRepository;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    repository = new ReservationsRepository(db);
    userId = await createTestUser(db);
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('reservations').execute();
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
    await db.deleteFrom('programs').execute();
  });

  it('creates a reservation and persists it', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReservationRow(programId, invoiceId, userId);

    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.programId).toBe(programId);
    expect(created.invoiceId).toBe(invoiceId);
    expect(created.status).toBe('ACTIVE');
    expect(created.createdByUserId).toBe(userId);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('persists exact original money, converted USD, rate, rate date, and source', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReservationRow(programId, invoiceId, userId, {
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

  it('finds a reservation by id', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReservationRow(programId, invoiceId, userId);
    await repository.create(row);

    const found = await repository.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding a missing id', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('finds the active reservation for an invoice', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReservationRow(programId, invoiceId, userId);
    await repository.create(row);

    const found = await repository.findActiveByInvoiceId(invoiceId);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when the invoice has no active reservation', async () => {
    const invoiceId = await createTestInvoice(db, userId);

    const found = await repository.findActiveByInvoiceId(invoiceId);
    expect(found).toBeNull();
  });

  it('lists reservations by program', async () => {
    const programId = await createTestProgram(db);
    const invoiceA = await createTestInvoice(db, userId);
    const invoiceB = await createTestInvoice(db, userId);
    const rowA = buildReservationRow(programId, invoiceA, userId);
    const rowB = buildReservationRow(programId, invoiceB, userId);
    await repository.create(rowA);
    await repository.create(rowB);

    const reservations = await repository.listByProgram(programId);
    expect(reservations.map((r) => r.id).sort()).toEqual(
      [rowA.id, rowB.id].sort(),
    );
  });

  describe('sumActiveByProgram', () => {
    it('returns zero when there are no active reservations', async () => {
      const programId = await createTestProgram(db);

      const sum = await repository.sumActiveByProgram(programId);

      expect(sum).toEqual({ amount: '0.0000', currency: 'USD' });
    });

    it('sums exactly across multiple active reservations', async () => {
      const programId = await createTestProgram(db);
      const invoiceA = await createTestInvoice(db, userId);
      const invoiceB = await createTestInvoice(db, userId);
      await repository.create(
        buildReservationRow(programId, invoiceA, userId, {
          convertedAmountUsd: '30.5000',
        }),
      );
      await repository.create(
        buildReservationRow(programId, invoiceB, userId, {
          convertedAmountUsd: '49.5000',
        }),
      );

      const sum = await repository.sumActiveByProgram(programId);

      expect(sum).toEqual({ amount: '80.0000', currency: 'USD' });
    });

    it('excludes reservations belonging to a different program', async () => {
      const programA = await createTestProgram(db);
      const programB = await createTestProgram(db);
      const invoiceA = await createTestInvoice(db, userId);
      await repository.create(
        buildReservationRow(programA, invoiceA, userId, {
          convertedAmountUsd: '30.0000',
        }),
      );

      const sum = await repository.sumActiveByProgram(programB);

      expect(sum).toEqual({ amount: '0.0000', currency: 'USD' });
    });
  });

  it('rejects an invalid Program foreign key', async () => {
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReservationRow(randomUUID(), invoiceId, userId);

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
    });
  });

  it('rejects an invalid Invoice foreign key', async () => {
    const programId = await createTestProgram(db);
    const row = buildReservationRow(programId, randomUUID(), userId);

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('rejects an invalid User (createdByUserId) foreign key', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    const row = buildReservationRow(programId, invoiceId, randomUUID());

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503',
    });
  });

  // Mandatory: the database's partial unique index (reservations_invoice_active_unique)
  // is the final authority - mapped to a typed domain error, not leaked as a raw
  // constraint violation (CLAUDE.md section 19).
  it('rejects a second ACTIVE reservation for the same invoice, mapped to ReservationAlreadyExistsError', async () => {
    const programId = await createTestProgram(db);
    const invoiceId = await createTestInvoice(db, userId);
    await repository.create(buildReservationRow(programId, invoiceId, userId));

    await expect(
      repository.create(buildReservationRow(programId, invoiceId, userId)),
    ).rejects.toBeInstanceOf(ReservationAlreadyExistsError);
  });
});
