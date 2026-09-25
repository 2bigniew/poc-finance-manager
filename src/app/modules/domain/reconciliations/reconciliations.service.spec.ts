import { Kysely } from 'kysely';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { Program } from '@app/modules/domain/programs/program.entity';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReconciliationProcessingError } from './exceptions/reconciliation-processing.error';
import { ReconciliationEventsRepository } from './reconciliation-events.repository';
import { Reconciliation } from './reconciliation.entity';
import { ReconcileProgramEntryInput } from './reconciliations.message-mapper';
import { ReconciliationsRepository } from './reconciliations.repository';
import { ReconciliationsService } from './reconciliations.service';

const ENVELOPE = {
  topic: 'treasury.reconciliation',
  partition: 0,
  offset: '0',
};

function buildProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'program-id',
    name: 'Test Program',
    originalCapacity: { amount: '1000.0000', currency: 'USD' },
    totalCapacityUsd: { amount: '1000.0000', currency: 'USD' },
    treasuryVersion: 10,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildEntry(
  overrides: Partial<ReconcileProgramEntryInput> = {},
): ReconcileProgramEntryInput {
  return {
    batchId: 'batch-1',
    programId: 'program-id',
    sourceVersion: 11,
    totalCapacityUsd: '1200.0000',
    effectiveAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function buildReconciliation(
  overrides: Partial<Reconciliation> = {},
): Reconciliation {
  return {
    id: 'reconciliation-id',
    batchId: 'batch-1',
    externalEventId: 'batch-1:program-id:11',
    programId: 'program-id',
    sourceVersion: 11,
    totalCapacityUsd: { amount: '1200.0000', currency: 'USD' },
    effectiveAt: new Date('2026-01-02T00:00:00.000Z'),
    status: 'APPLIED',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

// Maps the flat row `ReconciliationsRepository.create` is actually called with back
// into a proper `Reconciliation` entity shape - the same mapping the real
// ReconciliationsRepository.toEntity performs. Needed because
// buildReconciliationAppliedEvent (called by ReconciliationsService AFTER the
// repository write, only when status is APPLIED) reads
// reconciliation.totalCapacityUsd as a Money object, not the raw row's decimal string.
function toReconciliationEntity(row: Record<string, unknown>): Reconciliation {
  return {
    id: row.id as string,
    batchId: row.batchId as string,
    externalEventId: row.externalEventId as string,
    programId: row.programId as string,
    sourceVersion: row.sourceVersion as number,
    totalCapacityUsd: {
      amount: row.totalCapacityUsd as string,
      currency: 'USD',
    },
    effectiveAt: row.effectiveAt as Date,
    status: row.status as Reconciliation['status'],
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

describe('ReconciliationsService', () => {
  let service: ReconciliationsService;
  let db: { transaction: jest.Mock };
  let trxMarker: { marker: 'trx' };
  let reconciliationsRepository: {
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>, unknown]>;
    findByExternalEventId: jest.Mock;
  };
  let reconciliationEventsRepository: {
    create: jest.Mock;
    findByExternalEventId: jest.Mock;
  };
  let programsService: {
    findByIdForUpdate: jest.Mock;
    applyReconciliation: jest.Mock;
  };
  let outboxRepository: { create: jest.Mock };

  beforeEach(() => {
    trxMarker = { marker: 'trx' };
    db = {
      transaction: jest.fn().mockReturnValue({
        execute: (callback: (trx: unknown) => Promise<unknown>) =>
          callback(trxMarker),
      }),
    };
    reconciliationsRepository = {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>, unknown]>(),
      findByExternalEventId: jest.fn().mockResolvedValue(null),
    };
    reconciliationEventsRepository = {
      create: jest.fn().mockResolvedValue({ id: 'event-id' }),
      findByExternalEventId: jest.fn().mockResolvedValue(null),
    };
    programsService = {
      findByIdForUpdate: jest.fn().mockResolvedValue(buildProgram()),
      applyReconciliation: jest
        .fn()
        .mockResolvedValue(buildProgram({ treasuryVersion: 11 })),
    };
    outboxRepository = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    service = new ReconciliationsService(
      db as unknown as Kysely<Database>,
      reconciliationsRepository as unknown as ReconciliationsRepository,
      reconciliationEventsRepository as unknown as ReconciliationEventsRepository,
      programsService as unknown as ProgramsService,
      outboxRepository as unknown as OutboxRepository,
    );
  });

  describe('reconcileProgramEntry - newer version (APPLIED)', () => {
    it('replaces totalCapacityUsd and treasuryVersion with the incoming values', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(buildEntry(), ENVELOPE);

      expect(programsService.applyReconciliation).toHaveBeenCalledWith(
        'program-id',
        10,
        expect.objectContaining({
          totalCapacityUsdAmount: '1200.0000',
          treasuryVersion: 11,
        }),
        trxMarker,
      );
      const [, , patch] = programsService.applyReconciliation.mock.calls[0] as [
        string,
        number,
        Record<string, unknown>,
        unknown,
      ];
      expect(patch.updatedAt).toBeInstanceOf(Date);
    });

    it('does not increment - it replaces (not += ) the total capacity', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(
        buildEntry({ totalCapacityUsd: '50.0000' }),
        ENVELOPE,
      );

      const [, , patch] = programsService.applyReconciliation.mock.calls[0] as [
        string,
        number,
        Record<string, unknown>,
        unknown,
      ];
      expect(patch.totalCapacityUsdAmount).toBe('50.0000');
    });

    it('persists a Reconciliation row with status APPLIED', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(buildEntry(), ENVELOPE);

      expect(reconciliationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'APPLIED',
          batchId: 'batch-1',
          programId: 'program-id',
          sourceVersion: 11,
          totalCapacityUsd: '1200.0000',
          externalEventId: 'batch-1:program-id:11',
        }),
        trxMarker,
      );
    });

    it('persists a ReconciliationEvent row carrying the Kafka envelope', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(buildEntry(), {
        topic: 'treasury.reconciliation',
        partition: 3,
        offset: '77',
      });

      expect(reconciliationEventsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          externalEventId: 'batch-1:program-id:11',
          topic: 'treasury.reconciliation',
          partition: 3,
          offset: '77',
          programId: 'program-id',
          batchId: 'batch-1',
          sourceVersion: 11,
        }),
        trxMarker,
      );
    });

    it('locks the Program (uses findByIdForUpdate, not findById)', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(buildEntry(), ENVELOPE);

      expect(programsService.findByIdForUpdate).toHaveBeenCalledWith(
        'program-id',
        trxMarker,
      );
    });

    it('writes a reconciliation.applied outbox row in the same transaction, keyed by programId', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(buildEntry(), ENVELOPE);

      expect(outboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'reconciliations.events',
          messageKey: 'program-id',
          eventType: 'reconciliation.applied',
        }),
        trxMarker,
      );
      const [row] = outboxRepository.create.mock.calls[0] as [
        Record<string, unknown>,
        unknown,
      ];
      expect(row.eventId).toBe(row.id);
      const payload = row.payload as {
        payload: { sourceVersion: number; totalCapacityUsd: unknown };
      };
      expect(payload.payload.sourceVersion).toBe(11);
      expect(payload.payload.totalCapacityUsd).toEqual({
        amount: '1200.0000',
        currency: 'USD',
      });
    });
  });

  describe('reconcileProgramEntry - stale/duplicate version (IGNORED_STALE)', () => {
    it('treats an older sourceVersion as IGNORED_STALE and does not touch the Program', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(
        buildEntry({ sourceVersion: 5 }),
        ENVELOPE,
      );

      expect(programsService.applyReconciliation).not.toHaveBeenCalled();
      expect(reconciliationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'IGNORED_STALE', sourceVersion: 5 }),
        trxMarker,
      );
    });

    it('treats an equal sourceVersion (duplicate) as IGNORED_STALE and does not touch the Program', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(
        buildEntry({ sourceVersion: 10 }),
        ENVELOPE,
      );

      expect(programsService.applyReconciliation).not.toHaveBeenCalled();
      expect(reconciliationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'IGNORED_STALE', sourceVersion: 10 }),
        trxMarker,
      );
    });

    it('does NOT roll Program state backward for a stale snapshot with a lower totalCapacityUsd', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(
        buildEntry({ sourceVersion: 5, totalCapacityUsd: '1.0000' }),
        ENVELOPE,
      );

      expect(programsService.applyReconciliation).not.toHaveBeenCalled();
    });

    it('does not write a reconciliation.applied outbox row for an IGNORED_STALE entry', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileProgramEntry(
        buildEntry({ sourceVersion: 5 }),
        ENVELOPE,
      );

      expect(outboxRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('reconcileProgramEntry - version gap', () => {
    it('still applies a snapshot that skips versions (gap), subsuming the missing ones', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      const result = await service.reconcileProgramEntry(
        buildEntry({ sourceVersion: 13 }),
        ENVELOPE,
      );

      expect(programsService.applyReconciliation).toHaveBeenCalledWith(
        'program-id',
        10,
        expect.objectContaining({ treasuryVersion: 13 }),
        trxMarker,
      );
      expect((result as unknown as { status: string }).status).toBe('APPLIED');
    });
  });

  describe('reconcileProgramEntry - idempotency', () => {
    it('returns the existing Reconciliation without touching the Program when the inbox already has this entry', async () => {
      const existing = buildReconciliation();
      reconciliationEventsRepository.findByExternalEventId.mockResolvedValue({
        id: 'event-id',
      });
      reconciliationsRepository.findByExternalEventId.mockResolvedValue(
        existing,
      );

      const result = await service.reconcileProgramEntry(
        buildEntry(),
        ENVELOPE,
      );

      expect(result).toBe(existing);
      expect(programsService.findByIdForUpdate).not.toHaveBeenCalled();
      expect(programsService.applyReconciliation).not.toHaveBeenCalled();
      expect(reconciliationsRepository.create).not.toHaveBeenCalled();
    });

    it('throws ReconciliationProcessingError when the inbox row exists but the audit row does not (desync)', async () => {
      reconciliationEventsRepository.findByExternalEventId.mockResolvedValue({
        id: 'event-id',
      });
      reconciliationsRepository.findByExternalEventId.mockResolvedValue(null);

      await expect(
        service.reconcileProgramEntry(buildEntry(), ENVELOPE),
      ).rejects.toBeInstanceOf(ReconciliationProcessingError);
      expect(programsService.findByIdForUpdate).not.toHaveBeenCalled();
    });
  });

  describe('reconcileProgramEntry - Program missing', () => {
    it('throws ProgramNotFoundError without writing any inbox/audit row', async () => {
      programsService.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.reconcileProgramEntry(buildEntry(), ENVELOPE),
      ).rejects.toBeInstanceOf(ProgramNotFoundError);
      expect(reconciliationsRepository.create).not.toHaveBeenCalled();
      expect(reconciliationEventsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('reconcileBulk', () => {
    it('processes every entry and resolves when all succeed', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );

      await service.reconcileBulk(
        {
          batchId: 'batch-1',
          entries: [
            buildEntry({ programId: 'program-a' }),
            buildEntry({ programId: 'program-b' }),
          ],
        },
        ENVELOPE,
      );

      expect(programsService.findByIdForUpdate).toHaveBeenCalledTimes(2);
    });

    it('continues processing remaining entries after one fails, then throws so the whole message retries', async () => {
      reconciliationsRepository.create.mockImplementation((row) =>
        Promise.resolve(toReconciliationEntity(row)),
      );
      programsService.findByIdForUpdate.mockImplementation(
        (programId: string) =>
          Promise.resolve(
            programId === 'program-b' ? null : buildProgram({ id: programId }),
          ),
      );

      await expect(
        service.reconcileBulk(
          {
            batchId: 'batch-1',
            entries: [
              buildEntry({ programId: 'program-a' }),
              buildEntry({ programId: 'program-b' }),
              buildEntry({ programId: 'program-c' }),
            ],
          },
          ENVELOPE,
        ),
      ).rejects.toBeInstanceOf(ReconciliationProcessingError);

      // program-a and program-c both got a real attempt despite program-b failing.
      expect(programsService.findByIdForUpdate).toHaveBeenCalledWith(
        'program-a',
        trxMarker,
      );
      expect(programsService.findByIdForUpdate).toHaveBeenCalledWith(
        'program-c',
        trxMarker,
      );
    });
  });
});
