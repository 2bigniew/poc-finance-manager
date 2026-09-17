import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from './kysely.provider';
import { Database } from './types/database.interface';
import { InvoiceStatus } from './types/tables/invoices.table';
import { ReservationStatus } from './types/tables/reservations.table';

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

// Schema-level guarantees this application depends on (CLAUDE.md "Integration Tests"),
// exercised directly through Kysely since no Programs/Invoices/Reservations/Releases/
// Reconciliations repositories exist yet (this migration step's explicit non-goal).
describe('Database schema constraints (Postgres integration)', () => {
  let db: Kysely<Database>;
  let userId: string;

  beforeAll(async () => {
    db = createKysely();
    userId = randomUUID();
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: `schema-constraints-${randomUUID()}@example.test`,
        passwordHash: 'hashed-password-placeholder',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.destroy();
  });

  afterEach(async () => {
    // Reverse dependency order so FK RESTRICT never blocks cleanup.
    await db.deleteFrom('releaseEvents').execute();
    await db.deleteFrom('reservationEvents').execute();
    await db.deleteFrom('reconciliationEvents').execute();
    await db.deleteFrom('outboxEvents').execute();
    await db.deleteFrom('releases').execute();
    await db.deleteFrom('reservations').execute();
    await db.deleteFrom('reconciliations').execute();
    await db.deleteFrom('invoices').execute();
    await db.deleteFrom('programs').execute();
  });

  async function createProgram(
    overrides: Partial<{ treasuryVersion: number }> = {},
  ) {
    const id = randomUUID();
    const now = new Date();
    await db
      .insertInto('programs')
      .values({
        id,
        name: `Program ${id}`,
        originalCapacityAmount: '1000000.0000',
        originalCapacityCurrency: 'USD',
        totalCapacityUsdAmount: '1000000.0000',
        treasuryVersion: overrides.treasuryVersion ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    return id;
  }

  async function createInvoice(
    overrides: Partial<{ status: InvoiceStatus }> = {},
  ) {
    const id = randomUUID();
    const now = new Date();
    await db
      .insertInto('invoices')
      .values({
        id,
        externalReference: `INV-${id}`,
        originalAmount: '1000.0000',
        originalCurrency: 'EUR',
        convertedAmountUsd: '1100.0000',
        conversionRate: '1.100000',
        conversionRateDate: now,
        conversionSource: 'frankfurter.dev',
        status: overrides.status ?? 'OPEN',
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    return id;
  }

  async function createReservation(
    programId: string,
    invoiceId: string,
    overrides: Partial<{ status: ReservationStatus }> = {},
  ) {
    const id = randomUUID();
    const now = new Date();
    await db
      .insertInto('reservations')
      .values({
        id,
        programId,
        invoiceId,
        originalAmount: '1000.0000',
        originalCurrency: 'EUR',
        convertedAmountUsd: '1100.0000',
        conversionRate: '1.100000',
        conversionRateDate: now,
        conversionSource: 'frankfurter.dev',
        status: overrides.status ?? 'ACTIVE',
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    return id;
  }

  describe('invalid foreign keys', () => {
    it('rejects a reservation referencing a non-existent program', async () => {
      const invoiceId = await createInvoice();

      await expect(
        db
          .insertInto('reservations')
          .values({
            id: randomUUID(),
            programId: randomUUID(),
            invoiceId,
            originalAmount: '100.0000',
            originalCurrency: 'USD',
            convertedAmountUsd: '100.0000',
            conversionRate: '1.000000',
            conversionRateDate: new Date(),
            conversionSource: 'frankfurter.dev',
            status: 'ACTIVE',
            createdByUserId: userId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .execute(),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });

    it('rejects an invoice referencing a non-existent user', async () => {
      await expect(
        db
          .insertInto('invoices')
          .values({
            id: randomUUID(),
            externalReference: `INV-${randomUUID()}`,
            originalAmount: '100.0000',
            originalCurrency: 'USD',
            convertedAmountUsd: '100.0000',
            conversionRate: '1.000000',
            conversionRateDate: new Date(),
            conversionSource: 'frankfurter.dev',
            status: 'OPEN',
            createdByUserId: randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .execute(),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });
  });

  // Mandatory per the migration task ("Active Reservation Constraint Test").
  describe('one active reservation per invoice', () => {
    it('rejects a second ACTIVE reservation for the same invoice', async () => {
      const programId = await createProgram();
      const invoiceId = await createInvoice();
      await createReservation(programId, invoiceId, { status: 'ACTIVE' });

      await expect(
        createReservation(programId, invoiceId, { status: 'ACTIVE' }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    // BUSINESS.md states "the same Invoice MUST NOT have more than one *active*
    // Reservation" and does not forbid reserving an invoice again after its prior
    // Reservation is released - so the schema's partial unique index (scoped to
    // status = 'ACTIVE') intentionally allows this. Whether the future
    // ReservationsService actually permits re-reserving a REPAID invoice is a business
    // decision out of scope for this migration step.
    it('allows a new ACTIVE reservation for the same invoice once the prior one is RELEASED', async () => {
      const programId = await createProgram();
      const invoiceId = await createInvoice();
      const firstReservationId = await createReservation(programId, invoiceId, {
        status: 'ACTIVE',
      });

      await db
        .updateTable('reservations')
        .set({ status: 'RELEASED', updatedAt: new Date() })
        .where('id', '=', firstReservationId)
        .execute();

      await expect(
        createReservation(programId, invoiceId, { status: 'ACTIVE' }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('one release per reservation', () => {
    it('rejects a second release for the same reservation', async () => {
      const programId = await createProgram();
      const invoiceId = await createInvoice();
      const reservationId = await createReservation(programId, invoiceId);

      const buildRelease = () => ({
        id: randomUUID(),
        reservationId,
        invoiceId,
        programId,
        originalAmount: '1000.0000',
        originalCurrency: 'EUR',
        convertedAmountUsd: '1100.0000',
        conversionRate: '1.100000',
        conversionRateDate: new Date(),
        conversionSource: 'frankfurter.dev' as const,
        createdByUserId: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.insertInto('releases').values(buildRelease()).execute();

      await expect(
        db.insertInto('releases').values(buildRelease()).execute(),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  describe('duplicate event identity', () => {
    it('rejects a duplicate reservation_events external_event_id', async () => {
      const programId = await createProgram();
      const invoiceId = await createInvoice();
      const reservationId = await createReservation(programId, invoiceId);
      const externalEventId = `evt-${randomUUID()}`;

      const buildEvent = () => ({
        id: randomUUID(),
        externalEventId,
        topic: 'reservations.events',
        partition: 0,
        offset: '0',
        eventType: 'reservation.created',
        payload: JSON.stringify({ reservationId }),
        programId,
        invoiceId,
        reservationId,
        receivedAt: new Date(),
        processedAt: null,
      });

      await db.insertInto('reservationEvents').values(buildEvent()).execute();

      await expect(
        db.insertInto('reservationEvents').values(buildEvent()).execute(),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('rejects a duplicate release_events external_event_id', async () => {
      const programId = await createProgram();
      const invoiceId = await createInvoice();
      const reservationId = await createReservation(programId, invoiceId);
      const externalEventId = `evt-${randomUUID()}`;

      const buildEvent = () => ({
        id: randomUUID(),
        externalEventId,
        topic: 'releases.events',
        partition: 0,
        offset: '0',
        eventType: 'release.created',
        payload: JSON.stringify({ reservationId }),
        programId,
        invoiceId,
        reservationId,
        releaseId: randomUUID(),
        receivedAt: new Date(),
        processedAt: null,
      });

      await db.insertInto('releaseEvents').values(buildEvent()).execute();

      await expect(
        db.insertInto('releaseEvents').values(buildEvent()).execute(),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('rejects a duplicate reconciliation_events external_event_id', async () => {
      const programId = await createProgram();
      const externalEventId = `evt-${randomUUID()}`;

      const buildEvent = () => ({
        id: randomUUID(),
        externalEventId,
        topic: 'treasury.capacity',
        partition: 0,
        offset: '0',
        eventType: 'reconciliation.capacity',
        payload: JSON.stringify({
          programId,
          sourceVersion: 1,
          totalCapacityUsd: '1000.0000',
          effectiveAt: new Date().toISOString(),
        }),
        programId,
        batchId: `batch-${randomUUID()}`,
        sourceVersion: 1,
        receivedAt: new Date(),
        processedAt: null,
      });

      await db
        .insertInto('reconciliationEvents')
        .values(buildEvent())
        .execute();

      await expect(
        db.insertInto('reconciliationEvents').values(buildEvent()).execute(),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  describe('duplicate outbox event identity', () => {
    it('rejects a duplicate outbox_events event_id', async () => {
      const eventId = `evt-${randomUUID()}`;
      const buildOutboxRow = () => ({
        id: randomUUID(),
        eventId,
        topic: 'reservations.events',
        messageKey: 'program-1',
        eventType: 'reservation.created',
        payload: JSON.stringify({ foo: 'bar' }),
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishedAt: null,
      });

      await db.insertInto('outboxEvents').values(buildOutboxRow()).execute();

      await expect(
        db.insertInto('outboxEvents').values(buildOutboxRow()).execute(),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  describe('exact decimal precision', () => {
    it('preserves NUMERIC amounts and FX rates exactly, without floating-point loss', async () => {
      const id = randomUUID();
      const now = new Date();

      await db
        .insertInto('invoices')
        .values({
          id,
          externalReference: `INV-${id}`,
          // 0.10 + 0.20 famously loses precision in IEEE-754 floating point.
          originalAmount: '0.10',
          originalCurrency: 'EUR',
          convertedAmountUsd: '1234567.89',
          conversionRate: '4.123456',
          conversionRateDate: now,
          conversionSource: 'frankfurter.dev',
          status: 'OPEN',
          createdByUserId: userId,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      const row = await db
        .selectFrom('invoices')
        .select(['originalAmount', 'convertedAmountUsd', 'conversionRate'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      expect(typeof row.originalAmount).toBe('string');
      expect(row.originalAmount).toBe('0.1000');
      expect(row.convertedAmountUsd).toBe('1234567.8900');
      expect(row.conversionRate).toBe('4.123456');

      const secondAmount = '0.20';
      await db
        .updateTable('invoices')
        .set({ originalAmount: secondAmount, updatedAt: new Date() })
        .where('id', '=', id)
        .execute();

      const updated = await db
        .selectFrom('invoices')
        .select('originalAmount')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      expect(updated.originalAmount).toBe('0.2000');
    });
  });
});
