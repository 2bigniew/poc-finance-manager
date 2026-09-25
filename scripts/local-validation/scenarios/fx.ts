import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScenarioContext } from '../support/scenario-runner';
import { sqlLiteral } from '../support/database-probe';
import { decimalGreaterThan, productWithin } from '../support/decimal';
import {
  createProgram,
  expectCapacity,
  expectStatus,
  getOk,
  registerAndLogin,
  release,
  requireString,
  reserve,
  sameMonetarySnapshot,
} from '../support/domain-actions';
import { stringAt } from '../support/json-path';
import { ValidationContext, runIdFor } from '../support/validation-context';
import { waitForAppReady } from './infrastructure';

// Connection-refused endpoint: FX calls fail fast without sabotaging any container.
const UNAVAILABLE_FX_URL = 'http://127.0.0.1:9';

export async function runFrankfurterSmokeScenario(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'fx-live');

  await ctx.runner.run(
    {
      id: 'frankfurter-eur-smoke',
      name: 'Live Frankfurter EUR smoke (non-deterministic, optional)',
      category: 'fx',
      runId,
      mandatory: false,
      expected:
        'EUR 100 Invoice -> converted USD = amount x rate (4dp), rate/date/source stored; reserve+release reuse the exact EUR->USD snapshot',
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
      const created = await ctx.api.post(
        '/invoices',
        {
          externalReference: `VALIDATION-${runId}-INV-EUR`,
          amount: '100',
          currency: 'EUR',
        },
        session.accessToken,
      );
      expectStatus(
        ctx,
        sc,
        created,
        201,
        'EUR invoice (requires public internet)',
      );
      const invoiceId = requireString(sc, created.body, 'id', 'invoice');
      sc.resource('programId', programId);
      sc.resource('invoiceId', invoiceId);

      const rate = stringAt(created.body, 'conversion.rate') ?? '';
      const converted =
        stringAt(created.body, 'convertedMoneyUsd.amount') ?? '';
      sc.observe(
        `EUR 100 -> USD ${converted} at rate ${rate} (rateDate=${stringAt(created.body, 'conversion.rateDate')}, source=${stringAt(created.body, 'conversion.source')})`,
      );
      sc.check(decimalGreaterThan(rate, '0'), 'rate not a positive decimal');
      sc.check(
        stringAt(created.body, 'convertedMoneyUsd.currency') === 'USD',
        'converted currency not USD',
      );
      sc.check(
        productWithin(converted, '100', rate, '0.0001'),
        'converted amount != amount x rate',
      );
      sc.check(
        Boolean(stringAt(created.body, 'conversion.rateDate')) &&
          Boolean(stringAt(created.body, 'conversion.source')),
        'rate date/source missing',
      );

      const reserved = await reserve(ctx, session, programId, invoiceId);
      expectStatus(ctx, sc, reserved, 201, 'reserve EUR invoice');
      const reservationId = requireString(
        sc,
        reserved.body,
        'id',
        'reservation',
      );
      sc.resource('reservationId', reservationId);
      sc.check(
        sameMonetarySnapshot(reserved.body, created.body),
        'Reservation did not reuse the Invoice FX snapshot',
      );
      const released = await release(ctx, session, reservationId);
      expectStatus(ctx, sc, released, 201, 'release');
      sc.resource(
        'releaseId',
        requireString(sc, released.body, 'id', 'release'),
      );
      sc.check(
        sameMonetarySnapshot(released.body, reserved.body),
        'Release did not reuse the Reservation FX snapshot',
      );
      sc.observe(
        'Reservation and Release carry the identical EUR->USD snapshot (no revaluation)',
      );
      await expectCapacity(
        ctx,
        sc,
        session,
        programId,
        { total: '1000', reserved: '0', available: '1000' },
        'after release',
      );
    },
  );
}

export async function runFrankfurterFailureScenario(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'fx-failure');
  const overrideFile = path.join(os.tmpdir(), `${runId}-compose.override.yaml`);

  await ctx.runner.run(
    {
      id: 'frankfurter-unavailable',
      name: 'FX provider unavailable -> no partial state',
      category: 'fx',
      runId,
      mandatory: false,
      expected: `app temporarily recreated with FRANKFURTER_BASE_URL=${UNAVAILABLE_FX_URL} (compose override, no code change): EUR invoice request fails with a non-2xx error without leaking AxiosError details; no Invoice/Reservation row persisted; app restored afterwards`,
    },
    async (sc: ScenarioContext) => {
      const session = await registerAndLogin(ctx, sc, runId);
      const externalReference = `VALIDATION-${runId}-INV-EUR`;
      sc.resource('invoiceExternalReference', externalReference);
      await writeFile(
        overrideFile,
        `services:\n  app:\n    environment:\n      FRANKFURTER_BASE_URL: ${UNAVAILABLE_FX_URL}\n`,
      );

      try {
        const up = await ctx.compose
          .withOverrideFile(overrideFile)
          .run(['up', '-d', '--no-deps', '--no-build', 'app'], {
            timeoutMs: 180_000,
          });
        sc.check(up.exitCode === 0, 'could not recreate app with FX override');
        await ctx.compose.waitHealthy(['app'], 180_000);
        await waitForAppReady(ctx, 120_000);
        sc.observe(
          'app recreated with unreachable FX base URL (compose override file)',
        );

        const response = await ctx.api.post(
          '/invoices',
          { externalReference, amount: '100', currency: 'EUR' },
          session.accessToken,
        );
        const body = JSON.stringify(response.body);
        sc.observe(
          `EUR invoice with FX down -> HTTP ${response.status} ${ctx.redactor.redact(body)}`,
        );
        sc.check(response.status >= 400, 'request unexpectedly succeeded');
        sc.check(
          !/AxiosError|ECONNREFUSED|127\.0\.0\.1/.test(body),
          'raw Axios/network details leaked to HTTP client',
        );

        const invoices = await ctx.db.count(
          `SELECT 1 FROM invoices WHERE external_reference = ${sqlLiteral(externalReference)}`,
        );
        const reservations = await ctx.db.count(
          `SELECT 1 FROM reservations r JOIN invoices i ON i.id = r.invoice_id WHERE i.external_reference = ${sqlLiteral(externalReference)}`,
        );
        sc.observe(
          `persisted rows for ${externalReference}: invoices=${invoices} reservations=${reservations}`,
        );
        sc.check(
          invoices === 0 && reservations === 0,
          'partial state persisted after FX failure',
        );

        const usd = await ctx.api.post(
          '/invoices',
          {
            externalReference: `VALIDATION-${runId}-INV-USD`,
            amount: '5',
            currency: 'USD',
          },
          session.accessToken,
        );
        sc.observe(
          `USD invoice with FX down -> HTTP ${usd.status} (USD needs no FX call)`,
        );
        sc.check(
          usd.status === 201,
          'USD invoice should not depend on FX availability',
        );
      } finally {
        await ctx.compose.run(['up', '-d', '--no-deps', '--no-build', 'app'], {
          timeoutMs: 180_000,
        });
        await ctx.compose.waitHealthy(['app'], 180_000);
        await waitForAppReady(ctx, 120_000);
      }
      const restored = await ctx.compose.run([
        'exec',
        '-T',
        'app',
        'printenv',
        'FRANKFURTER_BASE_URL',
      ]);
      sc.check(
        restored.stdout.trim() !== UNAVAILABLE_FX_URL,
        'app still running with FX override',
      );
      sc.observe(
        `app restored with original configuration (FRANKFURTER_BASE_URL=${restored.stdout.trim()})`,
      );
      await getOk(ctx, sc, session, '/auth/me');
    },
  );
}
