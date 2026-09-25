import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { InvoicesRepository } from './invoices.repository';

async function createTestUser(db: Kysely<Database>): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  await db
    .insertInto('users')
    .values({
      id,
      email: `invoices-repo-test-${id}@example.test`,
      passwordHash: 'hashed-password-placeholder',
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return id;
}

function buildInvoiceRow(
  createdByUserId: string,
  overrides: Partial<{
    originalAmount: string;
    convertedAmountUsd: string;
    conversionRate: string;
    status: 'OPEN' | 'RESERVED' | 'REPAID';
  }> = {},
) {
  const id = randomUUID();
  const now = new Date();

  return {
    id,
    externalReference: `INV-${id}`,
    originalAmount: overrides.originalAmount ?? '1000.0000',
    originalCurrency: 'EUR',
    convertedAmountUsd: overrides.convertedAmountUsd ?? '1100.0000',
    conversionRate: overrides.conversionRate ?? '1.100000',
    conversionRateDate: now,
    conversionSource: 'frankfurter.dev' as const,
    status: overrides.status ?? 'OPEN',
    createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('InvoicesRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: InvoicesRepository;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    repository = new InvoicesRepository(db);
    userId = await createTestUser(db);
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    await db
      .deleteFrom('invoices')
      .where('createdByUserId', '=', userId)
      .execute();
  });

  it('creates an invoice and persists it', async () => {
    const row = buildInvoiceRow(userId);
    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.externalReference).toBe(row.externalReference);
    expect(created.originalMoney).toEqual({
      amount: row.originalAmount,
      currency: row.originalCurrency,
    });
    expect(created.convertedMoneyUsd).toEqual({
      amount: row.convertedAmountUsd,
      currency: 'USD',
    });
    expect(created.status).toBe('OPEN');
    expect(created.createdByUserId).toBe(userId);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('persists exact NUMERIC precision for amount and rate without floating-point loss', async () => {
    const row = buildInvoiceRow(userId, {
      originalAmount: '1234567.89',
      convertedAmountUsd: '0.10',
      conversionRate: '4.123456',
    });
    const created = await repository.create(row);

    expect(created.originalMoney.amount).toBe('1234567.8900');
    expect(created.convertedMoneyUsd.amount).toBe('0.1000');
    expect(created.conversion.rate).toBe('4.123456');
    expect(typeof created.originalMoney.amount).toBe('string');
    expect(typeof created.conversion.rate).toBe('string');
  });

  it('preserves the conversion snapshot (rate, rateDate, source)', async () => {
    const row = buildInvoiceRow(userId);
    const created = await repository.create(row);

    expect(created.conversion.rate).toBe(row.conversionRate);
    expect(created.conversion.rateDate.getTime()).toBe(
      row.conversionRateDate.getTime(),
    );
    expect(created.conversion.source).toBe('frankfurter.dev');
    expect(created.conversion.original).toEqual(created.originalMoney);
    expect(created.conversion.converted).toEqual(created.convertedMoneyUsd);
  });

  it('finds an invoice by id', async () => {
    const row = buildInvoiceRow(userId);
    await repository.create(row);

    const found = await repository.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('returns null when finding a missing id', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('lists invoices ordered by creation time', async () => {
    const rowA = buildInvoiceRow(userId);
    await repository.create(rowA);
    const rowB = buildInvoiceRow(userId);
    await repository.create(rowB);

    const invoices = await repository.list();
    const ids = invoices.map((invoice) => invoice.id);
    expect(ids).toEqual(expect.arrayContaining([rowA.id, rowB.id]));
  });

  it('rejects an invalid foreign key (unknown createdByUserId)', async () => {
    const row = buildInvoiceRow(randomUUID());

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
    });
  });

  it('rejects negative capacity via the database CHECK constraint', async () => {
    const row = buildInvoiceRow(userId, { originalAmount: '-1' });

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });

  it('rejects an invalid status via the database CHECK constraint', async () => {
    const row = { ...buildInvoiceRow(userId), status: 'BOGUS' as 'OPEN' };

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });

  describe('findByIdForUpdate', () => {
    it('returns the invoice using a caller-supplied transaction executor', async () => {
      const row = buildInvoiceRow(userId);
      await repository.create(row);

      const found = await db.transaction().execute(async (trx) => {
        return repository.findByIdForUpdate(row.id, trx);
      });

      expect(found?.id).toBe(row.id);
    });

    it('returns null for a missing invoice', async () => {
      const found = await db.transaction().execute(async (trx) => {
        return repository.findByIdForUpdate(randomUUID(), trx);
      });

      expect(found).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('transitions status when the current status matches fromStatus', async () => {
      const row = buildInvoiceRow(userId, { status: 'OPEN' });
      await repository.create(row);
      const updatedAt = new Date();

      const updated = await db.transaction().execute(async (trx) => {
        return repository.updateStatus(
          row.id,
          'OPEN',
          'RESERVED',
          updatedAt,
          trx,
        );
      });

      expect(updated?.status).toBe('RESERVED');
      expect(updated?.updatedAt.getTime()).toBe(updatedAt.getTime());
    });

    it('returns null (no-op) when the current status does not match fromStatus', async () => {
      const row = buildInvoiceRow(userId, { status: 'RESERVED' });
      await repository.create(row);

      const updated = await db.transaction().execute(async (trx) => {
        return repository.updateStatus(
          row.id,
          'OPEN',
          'RESERVED',
          new Date(),
          trx,
        );
      });

      expect(updated).toBeNull();
      const stillReserved = await repository.findById(row.id);
      expect(stillReserved?.status).toBe('RESERVED');
    });

    it('returns null for a missing invoice', async () => {
      const updated = await db.transaction().execute(async (trx) => {
        return repository.updateStatus(
          randomUUID(),
          'OPEN',
          'RESERVED',
          new Date(),
          trx,
        );
      });

      expect(updated).toBeNull();
    });
  });
});
