import { sqlLiteral } from '../support/database-probe';
import { decimalEquals } from '../support/decimal';
import {
  OutboxRow,
  Session,
  capacityOf,
  createInvoice,
  createProgram,
  derivedExternalEventId,
  expectCapacity,
  expectSingleOutboxEventPublished,
  expectStatus,
  getOk,
  outboxRowsFor,
  publishReconciliation,
  registerAndLogin,
  release,
  requireString,
  reserve,
  waitForProgram,
} from '../support/domain-actions';
import { numberAt, stringAt } from '../support/json-path';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import {
  RELEASE_EVENTS_TOPIC,
  RESERVATION_EVENTS_TOPIC,
  ValidationContext,
  runIdFor,
} from '../support/validation-context';
import { sleep } from '../support/wait';
import { expectBaselinePreserved, waitForAppReady } from './infrastructure';

async function ensureKafkaRunning(ctx: ValidationContext): Promise<void> {
  const states = await ctx.compose.serviceStates();
  const kafka = states.find((state) => state.service === 'kafka');
  if (kafka?.state !== 'running') {
    await ctx.compose.run(['start', 'kafka']);
  }
  await ctx.compose.waitHealthy(['kafka'], 240_000);
}

async function singleOutboxRow(
  ctx: ValidationContext,
  sc: ScenarioContext,
  eventType: string,
  field: string,
  id: string,
): Promise<OutboxRow> {
  const rows = await outboxRowsFor(ctx, eventType, field, id);
  sc.check(
    rows.length === 1,
    `expected exactly 1 ${eventType} outbox row, found ${rows.length}`,
  );
  const [row] = rows;
  sc.check(row !== undefined, 'missing outbox row');
  return row;
}

export async function runKafkaOutageScenario(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'kafka-outage');

  await ctx.runner.run(
    {
      id: 'kafka-unavailable-outbox-recovery',
      name: 'Kafka outage: domain commits, outbox recovers',
      category: 'kafka-outbox',
      runId,
      mandatory: true,
      expected:
        'with Kafka stopped: reserve+release return 201, outbox rows stay unpublished; after Kafka restart: same eventIds published (publishedAt set), visible on topics to a unique observer group; consumer resumes',
    },
    async (sc: ScenarioContext) => {
      const session = await registerAndLogin(ctx, sc, runId);
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}`,
        '1000',
      );
      const invoiceId = requireString(
        sc,
        (
          await createInvoice(
            ctx,
            sc,
            session,
            `VALIDATION-${runId}-INV-01`,
            '125',
          )
        ).body,
        'id',
        'invoice',
      );
      sc.resource('programId', programId);
      sc.resource('invoiceId', invoiceId);

      try {
        const stop = await ctx.compose.run(['stop', 'kafka'], {
          timeoutMs: 120_000,
        });
        sc.check(stop.exitCode === 0, 'docker compose stop kafka failed');
        await ctx.compose.waitStopped('kafka', 60_000);
        sc.observe('$ docker compose stop kafka -> kafka stopped');

        const readiness = await ctx.api.get('/readiness');
        sc.observe(`/readiness during outage -> ${readiness.status}`);

        const reserved = await reserve(ctx, session, programId, invoiceId);
        expectStatus(ctx, sc, reserved, 201, 'reserve while Kafka down');
        const reservationId = requireString(
          sc,
          reserved.body,
          'id',
          'reservation',
        );
        sc.resource('reservationId', reservationId);
        const released = await release(ctx, session, reservationId);
        expectStatus(ctx, sc, released, 201, 'release while Kafka down');
        const releaseId = requireString(sc, released.body, 'id', 'release');
        sc.resource('releaseId', releaseId);
        sc.observe(
          'reserve -> 201 and release -> 201 committed while Kafka was down',
        );

        // Several publisher poll intervals pass while Kafka is still down.
        await sleep(6_000);
        const reservationRow = await singleOutboxRow(
          ctx,
          sc,
          'reservation.created',
          'reservationId',
          reservationId,
        );
        const releaseRow = await singleOutboxRow(
          ctx,
          sc,
          'release.created',
          'releaseId',
          releaseId,
        );
        sc.resource('reservationEventId', reservationRow.eventId);
        sc.resource('releaseEventId', releaseRow.eventId);
        sc.observe(
          `outbox during outage: reservation.created publishedAt=${reservationRow.publishedAt} attempts=${reservationRow.attempts}; release.created publishedAt=${releaseRow.publishedAt} attempts=${releaseRow.attempts}`,
        );
        sc.check(
          reservationRow.publishedAt === null &&
            releaseRow.publishedAt === null,
          'outbox rows published while Kafka was down?',
        );

        const start = await ctx.compose.run(['start', 'kafka'], {
          timeoutMs: 120_000,
        });
        sc.check(start.exitCode === 0, 'docker compose start kafka failed');
        const kafkaStart = Date.now();
        await ctx.compose.waitHealthy(['kafka'], 240_000);
        sc.observe(
          `$ docker compose start kafka -> healthy after ${Date.now() - kafkaStart}ms`,
        );

        const publishedReservation = await expectSingleOutboxEventPublished(
          ctx,
          sc,
          'reservation.created',
          'reservationId',
          reservationId,
          180_000,
        );
        const publishedRelease = await expectSingleOutboxEventPublished(
          ctx,
          sc,
          'release.created',
          'releaseId',
          releaseId,
          180_000,
        );
        sc.check(
          publishedReservation.eventId === reservationRow.eventId &&
            publishedRelease.eventId === releaseRow.eventId,
          'eventId changed during recovery',
        );
        sc.observe(
          'eventIds stable across outage; publishedAt now set on both rows',
        );

        const observerGroup = `validation-observer-${runId}`;
        sc.resource('observerGroup', observerGroup);
        const seenReservation = await ctx.kafka.countRecordsContaining(
          RESERVATION_EVENTS_TOPIC,
          reservationRow.eventId,
          `${observerGroup}-reservations`,
          60_000,
        );
        const seenRelease = await ctx.kafka.countRecordsContaining(
          RELEASE_EVENTS_TOPIC,
          releaseRow.eventId,
          `${observerGroup}-releases`,
          60_000,
        );
        sc.observe(
          `observer (unique group ${observerGroup}-*) saw reservation event x${seenReservation}, release event x${seenRelease} (>=1 expected; >1 allowed by at-least-once)`,
        );
        sc.check(
          seenReservation >= 1 && seenRelease >= 1,
          'recovered events not found on Kafka topics',
        );

        const version =
          numberAt(
            await getOk(ctx, sc, session, `/programs/${programId}`),
            'treasuryVersion',
          ) ?? 0;
        await publishReconciliation(
          ctx,
          `${runId}-batch-01`,
          [
            {
              programId,
              sourceVersion: version + 1,
              totalCapacityUsd: '1300.0000',
            },
          ],
          programId,
        );
        await waitForProgram(
          ctx,
          session,
          programId,
          (body) => numberAt(body, 'treasuryVersion') === version + 1,
          'reconciliation after Kafka restart',
          120_000,
        );
        sc.observe(
          'treasury consumer resumed: post-outage reconciliation applied',
        );
        await expectCapacity(
          ctx,
          sc,
          session,
          programId,
          { total: '1300', reserved: '0', available: '1300' },
          'final',
        );
      } finally {
        await ensureKafkaRunning(ctx);
      }
    },
  );
}

interface RestartFixture {
  session: Session;
  programId: string;
  batchId: string;
  sourceVersion: number;
  externalEventId: string;
  programBefore: unknown;
}

export async function runAppRestartScenarios(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'restart');
  let fixture: RestartFixture | undefined;
  const trackedBefore = [...ctx.trackedPrograms];

  await ctx.runner.run(
    {
      id: 'app-restart',
      name: 'Application restart preserves state',
      category: 'restart-recovery',
      runId,
      mandatory: true,
      expected:
        'docker compose restart app -> ready again; earlier validation Programs identical via API; pre-existing data intact; access token issued before restart still valid',
    },
    async (sc: ScenarioContext) => {
      const session = await registerAndLogin(ctx, sc, runId);
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}`,
        '1000',
      );
      sc.resource('programId', programId);
      const version =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programId}`),
          'treasuryVersion',
        ) ?? 0;
      const batchId = `${runId}-batch-01`;
      const sourceVersion = version + 1;
      await publishReconciliation(
        ctx,
        batchId,
        [{ programId, sourceVersion, totalCapacityUsd: '2222.0000' }],
        programId,
      );
      const programBefore = await waitForProgram(
        ctx,
        session,
        programId,
        (body) => numberAt(body, 'treasuryVersion') === sourceVersion,
        'pre-restart reconciliation',
      );
      fixture = {
        session,
        programId,
        batchId,
        sourceVersion,
        externalEventId: derivedExternalEventId({
          batchId,
          programId,
          sourceVersion,
        }),
        programBefore,
      };
      sc.resource('externalEventId', fixture.externalEventId);
      sc.observe(
        `pre-restart reconciliation ${fixture.externalEventId} applied (total 2222)`,
      );

      const snapshotsBefore = new Map<string, string>();
      for (const tracked of trackedBefore) {
        snapshotsBefore.set(
          tracked.programId,
          JSON.stringify(
            await getOk(ctx, sc, session, `/programs/${tracked.programId}`),
          ),
        );
      }

      const restart = await ctx.compose.run(['restart', 'app'], {
        timeoutMs: 180_000,
      });
      sc.check(restart.exitCode === 0, 'docker compose restart app failed');
      const restartedAt = Date.now();
      await ctx.compose.waitHealthy(['app'], 180_000);
      await waitForAppReady(ctx, 120_000);
      sc.observe(
        `$ docker compose restart app -> ready after ${Date.now() - restartedAt}ms`,
      );

      for (const [programId, before] of snapshotsBefore) {
        const after = JSON.stringify(
          await getOk(ctx, sc, session, `/programs/${programId}`),
        );
        sc.check(
          after === before,
          `Program ${programId} differs after restart`,
        );
      }
      sc.observe(
        `${snapshotsBefore.size} earlier validation Programs byte-identical via API after restart (same id/total/reserved/available/version)`,
      );
      const own = await getOk(ctx, sc, session, `/programs/${programId}`);
      sc.check(
        JSON.stringify(own) === JSON.stringify(programBefore),
        'restart fixture Program changed',
      );
      sc.observe(
        'access token issued before restart still accepted (stateless JWT, same signing config)',
      );
      await expectBaselinePreserved(ctx, sc);
    },
  );
  const dependsOn = [scenarioKey(runId, 'app-restart')];

  await ctx.runner.run(
    {
      id: 'consumer-reconnect',
      name: 'Kafka consumer reconnects after app restart',
      category: 'restart-recovery',
      runId,
      mandatory: true,
      expected: 'new reconciliation published after restart is applied',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(fixture !== undefined, 'no fixture');
      const { session } = fixture;
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-reconnect`,
        '10',
      );
      sc.resource('programId', programId);
      const version =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programId}`),
          'treasuryVersion',
        ) ?? 0;
      await publishReconciliation(
        ctx,
        `${runId}-reconnect-batch-01`,
        [
          {
            programId,
            sourceVersion: version + 1,
            totalCapacityUsd: '20.0000',
          },
        ],
        programId,
      );
      const program = await waitForProgram(
        ctx,
        session,
        programId,
        (body) => numberAt(body, 'treasuryVersion') === version + 1,
        'post-restart reconciliation',
        90_000,
      );
      sc.observe(
        `post-restart snapshot applied: total=${capacityOf(program).total}`,
      );
    },
  );

  await ctx.runner.run(
    {
      id: 'reconciliation-redelivery-after-restart',
      name: 'Reconciliation redelivered after restart applies once',
      category: 'restart-recovery',
      runId,
      mandatory: true,
      expected:
        'the logical event applied before restart is delivered again after restart -> no second application: 1 reconciliation row, 1 inbox row, 1 applied outbox event, Program unchanged',
      dependsOn: [scenarioKey(runId, 'consumer-reconnect')],
    },
    async (sc: ScenarioContext) => {
      sc.check(fixture !== undefined, 'no fixture');
      const {
        session,
        programId,
        batchId,
        sourceVersion,
        externalEventId,
        programBefore,
      } = fixture;
      sc.resource('programId', programId);
      sc.resource('externalEventId', externalEventId);
      await publishReconciliation(
        ctx,
        batchId,
        [{ programId, sourceVersion, totalCapacityUsd: '2222.0000' }],
        programId,
      );
      sc.observe(
        'redelivered identical logical event (republish; offsets not manipulated)',
      );

      // A marker snapshot published behind the redelivery on the same key/partition
      // proves the redelivered record has been consumed before asserting on state.
      const version =
        numberAt(
          await getOk(ctx, sc, session, `/programs/${programId}`),
          'treasuryVersion',
        ) ?? 0;
      const markerVersion = version + 1;
      await publishReconciliation(
        ctx,
        `${runId}-marker-batch`,
        [
          {
            programId,
            sourceVersion: markerVersion,
            totalCapacityUsd: '2222.0000',
          },
        ],
        programId,
      );
      await waitForProgram(
        ctx,
        session,
        programId,
        (body) => numberAt(body, 'treasuryVersion') === markerVersion,
        'marker behind redelivery',
        60_000,
      );
      sc.observe(
        'marker event published behind the redelivery (same partition) consumed -> redelivery provably processed',
      );

      const rows = await ctx.db.count(
        `SELECT 1 FROM reconciliations WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      const inbox = await ctx.db.count(
        `SELECT 1 FROM reconciliation_events WHERE external_event_id = ${sqlLiteral(externalEventId)}`,
      );
      const outbox = await ctx.db.count(
        `SELECT 1 FROM outbox_events WHERE event_type = 'reconciliation.applied' AND payload->'payload'->>'externalEventId' = ${sqlLiteral(externalEventId)}`,
      );
      sc.observe(
        `for ${externalEventId}: reconciliations=${rows} inbox=${inbox} applied outbox=${outbox}`,
      );
      sc.check(
        rows === 1 && inbox === 1 && outbox === 1,
        'redelivered reconciliation applied more than once',
      );
      const program = await getOk(ctx, sc, session, `/programs/${programId}`);
      sc.check(
        decimalEquals(capacityOf(program).total, '2222'),
        'Program total changed',
      );
      sc.check(
        stringAt(program, 'createdAt') === stringAt(programBefore, 'createdAt'),
        'Program identity changed',
      );
    },
  );

  await ctx.runner.run(
    {
      id: 'outbox-resumes-after-restart',
      name: 'Outbox publisher resumes after restart',
      category: 'restart-recovery',
      runId,
      mandatory: true,
      expected:
        'reservation created after restart -> reservation.created outbox row published',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(fixture !== undefined, 'no fixture');
      const { session } = fixture;
      const programId = await createProgram(
        ctx,
        sc,
        session,
        `Validation Program ${runId}-outbox`,
        '100',
      );
      const invoiceId = requireString(
        sc,
        (
          await createInvoice(
            ctx,
            sc,
            session,
            `VALIDATION-${runId}-INV-01`,
            '10',
          )
        ).body,
        'id',
        'invoice',
      );
      const reserved = await reserve(ctx, session, programId, invoiceId);
      expectStatus(ctx, sc, reserved, 201, 'reserve');
      const reservationId = requireString(
        sc,
        reserved.body,
        'id',
        'reservation',
      );
      sc.resource('programId', programId);
      sc.resource('reservationId', reservationId);
      await expectSingleOutboxEventPublished(
        ctx,
        sc,
        'reservation.created',
        'reservationId',
        reservationId,
        60_000,
      );
    },
  );
}
