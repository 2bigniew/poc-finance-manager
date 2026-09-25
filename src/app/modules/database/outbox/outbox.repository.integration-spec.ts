import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from './outbox.repository';

function buildRow(overrides: Partial<{ messageKey: string | null }> = {}) {
  const id = randomUUID();
  const now = new Date();

  return {
    id,
    eventId: id,
    topic: 'reservations.events',
    messageKey:
      overrides.messageKey === undefined ? 'program-1' : overrides.messageKey,
    eventType: 'reservation.created',
    payload: { reservationId: 'reservation-1', programId: 'program-1' },
    createdAt: now,
    updatedAt: now,
  };
}

describe('OutboxRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: OutboxRepository;

  beforeAll(() => {
    db = createKysely();
    repository = new OutboxRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('outboxEvents').execute();
  });

  it('creates an unpublished row with zero attempts', async () => {
    const row = buildRow();

    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.eventId).toBe(row.eventId);
    expect(created.topic).toBe('reservations.events');
    expect(created.messageKey).toBe('program-1');
    expect(created.eventType).toBe('reservation.created');
    expect(created.attempts).toBe(0);
    expect(created.publishedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('round-trips the JSON payload exactly', async () => {
    const row = buildRow();

    const created = await repository.create(row);

    expect(created.payload).toEqual({
      reservationId: 'reservation-1',
      programId: 'program-1',
    });
  });

  it('rejects a duplicate eventId', async () => {
    const row = buildRow();
    await repository.create(row);

    await expect(
      repository.create({ ...buildRow(), eventId: row.eventId }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('persists a null messageKey', async () => {
    const row = buildRow({ messageKey: null });

    const created = await repository.create(row);

    expect(created.messageKey).toBeNull();
  });

  describe('findUnpublishedBatch', () => {
    it('returns only unpublished rows, oldest first', async () => {
      const first = await repository.create(buildRow());
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await repository.create(buildRow());
      const published = await repository.create(buildRow());
      await repository.markPublished(published.id, new Date());

      const batch = await repository.findUnpublishedBatch(10);

      const ids = batch.map((record) => record.id);
      expect(ids).toContain(first.id);
      expect(ids).toContain(second.id);
      expect(ids).not.toContain(published.id);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    });

    it('respects the batch limit', async () => {
      await repository.create(buildRow());
      await repository.create(buildRow());
      await repository.create(buildRow());

      const batch = await repository.findUnpublishedBatch(2);

      expect(batch).toHaveLength(2);
    });

    it('returns an empty array when nothing is unpublished', async () => {
      const batch = await repository.findUnpublishedBatch(10);

      expect(batch).toEqual([]);
    });
  });

  describe('incrementAttempts', () => {
    it('increments attempts and does not touch publishedAt', async () => {
      const created = await repository.create(buildRow());

      await repository.incrementAttempts(created.id, new Date());
      await repository.incrementAttempts(created.id, new Date());

      const [row] = await repository.findUnpublishedBatch(10);
      expect(row?.attempts).toBe(2);
      expect(row?.publishedAt).toBeNull();
    });
  });

  describe('markPublished', () => {
    it('sets publishedAt and removes the row from future unpublished batches', async () => {
      const created = await repository.create(buildRow());
      const publishedAt = new Date();

      const updated = await repository.markPublished(created.id, publishedAt);

      expect(updated?.publishedAt?.getTime()).toBe(publishedAt.getTime());
      const batch = await repository.findUnpublishedBatch(10);
      expect(batch.map((r) => r.id)).not.toContain(created.id);
    });

    it('returns null and is a no-op when the row is already published', async () => {
      const created = await repository.create(buildRow());
      const firstPublishedAt = new Date();
      await repository.markPublished(created.id, firstPublishedAt);

      const second = await repository.markPublished(created.id, new Date());

      expect(second).toBeNull();
      const found = await repository.findByEventId(created.eventId);
      expect(found?.publishedAt?.getTime()).toBe(firstPublishedAt.getTime());
    });

    it('returns null for an unknown id', async () => {
      const result = await repository.markPublished(randomUUID(), new Date());

      expect(result).toBeNull();
    });
  });

  describe('findByEventId', () => {
    it('finds a row by its logical eventId', async () => {
      const created = await repository.create(buildRow());

      const found = await repository.findByEventId(created.eventId);

      expect(found?.id).toBe(created.id);
    });

    it('returns null for an unknown eventId', async () => {
      const found = await repository.findByEventId(randomUUID());

      expect(found).toBeNull();
    });
  });
});
