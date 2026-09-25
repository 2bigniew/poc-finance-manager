import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createKysely } from '@app/modules/database/kysely.provider';
import { Database } from '@app/modules/database/types/database.interface';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';

function buildEventRow(
  overrides: Partial<{
    externalEventId: string;
    programId: string;
    batchId: string;
    sourceVersion: number;
  }> = {},
) {
  const id = randomUUID();
  const now = new Date();
  const programId = overrides.programId ?? randomUUID();
  const batchId = overrides.batchId ?? `batch-${id}`;
  const sourceVersion = overrides.sourceVersion ?? 1;

  return {
    id,
    externalEventId:
      overrides.externalEventId ?? `${batchId}:${programId}:${sourceVersion}`,
    topic: 'treasury.reconciliation',
    partition: 0,
    offset: '42',
    eventType: 'treasury.reconciliation',
    payload: {
      programId,
      sourceVersion,
      totalCapacityUsd: '1200.0000',
      effectiveAt: now.toISOString(),
    },
    programId,
    batchId,
    sourceVersion,
    receivedAt: now,
    processedAt: now,
  };
}

describe('ReconciliationEventsRepository Postgres integration', () => {
  let db: Kysely<Database>;
  let repository: ReconciliationEventsRepository;

  beforeAll(() => {
    db = createKysely();
    repository = new ReconciliationEventsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('reconciliationEvents').execute();
  });

  it('creates an event and persists it, round-tripping the JSON payload', async () => {
    const row = buildEventRow();

    const created = await repository.create(row);

    expect(created.id).toBe(row.id);
    expect(created.externalEventId).toBe(row.externalEventId);
    expect(created.topic).toBe('treasury.reconciliation');
    expect(created.partition).toBe(0);
    expect(created.offset).toBe('42');
    expect(created.programId).toBe(row.programId);
    expect(created.batchId).toBe(row.batchId);
    expect(created.sourceVersion).toBe(1);
    expect(created.payload).toEqual(row.payload);
    expect(created.receivedAt).toBeInstanceOf(Date);
    expect(created.processedAt).toBeInstanceOf(Date);
  });

  it('finds an event by externalEventId', async () => {
    const row = buildEventRow();
    await repository.create(row);

    const found = await repository.findByExternalEventId(row.externalEventId);
    expect(found?.id).toBe(row.id);
    expect(found?.payload).toEqual(row.payload);
  });

  it('returns null when finding a missing externalEventId', async () => {
    const found = await repository.findByExternalEventId('does-not-exist');
    expect(found).toBeNull();
  });

  it('rejects an empty externalEventId via the database CHECK constraint', async () => {
    const row = { ...buildEventRow(), externalEventId: '' };

    await expect(repository.create(row)).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });

  // Mandatory: UNIQUE(external_event_id) is the idempotency guarantee for the inbox
  // table itself (INFRASTRUCTURE.md "Idempotent Consumption / Inbox"; CLAUDE.md section
  // 38: "Also test ReconciliationEvent uniqueness/dedup rules"). The repository itself
  // just propagates the raw violation - see the matching comment on
  // ReconciliationsRepository's equivalent test for why recovery lives in
  // ReconciliationsService instead (it can only safely run after the transaction that
  // hit this violation has fully rolled back).
  it('rejects a second insert for the same externalEventId with a raw unique-violation error', async () => {
    const externalEventId = `batch-x:${randomUUID()}:1`;
    const firstRow = buildEventRow({ externalEventId });
    await repository.create(firstRow);

    const secondRow = buildEventRow({ externalEventId });
    await expect(repository.create(secondRow)).rejects.toMatchObject({
      code: '23505', // unique_violation
    });

    const allRows = await db
      .selectFrom('reconciliationEvents')
      .selectAll()
      .where('externalEventId', '=', externalEventId)
      .execute();
    expect(allRows).toHaveLength(1);
  });

  it('does not require a valid Program foreign key (inbox rows are independent of Program lifecycle)', async () => {
    const row = buildEventRow({ programId: randomUUID() });

    await expect(repository.create(row)).resolves.toMatchObject({
      programId: row.programId,
    });
  });
});
