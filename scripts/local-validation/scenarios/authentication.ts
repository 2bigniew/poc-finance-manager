import {
  Session,
  expectStatus,
  registerAndLogin,
  requireString,
} from '../support/domain-actions';
import { stringAt } from '../support/json-path';
import { ScenarioContext, scenarioKey } from '../support/scenario-runner';
import { ValidationContext, runIdFor } from '../support/validation-context';

export async function runAuthenticationScenarios(
  ctx: ValidationContext,
): Promise<void> {
  const runId = runIdFor(ctx, 'auth');
  let session: Session | undefined;

  await ctx.runner.run(
    {
      id: 'refresh-rotation',
      name: 'Refresh-token rotation rejects reuse',
      category: 'authentication',
      runId,
      mandatory: true,
      expected:
        'login -> refresh 200 with new, different refresh token; new access token works; reusing old refresh token -> 401',
    },
    async (sc: ScenarioContext) => {
      session = await registerAndLogin(ctx, sc, runId);
      const oldRefresh = session.refreshToken;

      const refreshed = await ctx.api.post('/auth/refresh', {
        refresh_token: oldRefresh,
      });
      expectStatus(ctx, sc, refreshed, 200, 'first refresh');
      const newRefresh = requireString(
        sc,
        refreshed.body,
        'refresh_token',
        'refresh',
      );
      const newAccess = requireString(
        sc,
        refreshed.body,
        'access_token',
        'refresh',
      );
      ctx.redactor.register(newRefresh);
      ctx.redactor.register(newAccess);
      sc.check(newRefresh !== oldRefresh, 'refresh token was not rotated');
      sc.observe(
        'refresh with original token -> 200, new refresh token differs from old',
      );

      const me = await ctx.api.get('/auth/me', newAccess);
      expectStatus(ctx, sc, me, 200, 'GET /auth/me with rotated access token');
      sc.observe('rotated access token accepted by GET /auth/me');

      const reuse = await ctx.api.post('/auth/refresh', {
        refresh_token: oldRefresh,
      });
      sc.observe(`reuse of old refresh token -> HTTP ${reuse.status}`);
      sc.check(
        reuse.status === 401,
        `old refresh token reuse expected 401, got ${reuse.status}`,
      );

      // Informational only: whether reuse detection also revokes the rotated token
      // (token-family revocation) is not mandated by the brief.
      const afterReuse = await ctx.api.post('/auth/refresh', {
        refresh_token: newRefresh,
      });
      sc.observe(
        `rotated refresh token after reuse attempt -> HTTP ${afterReuse.status} (informational)`,
      );
      const latest = stringAt(afterReuse.body, 'refresh_token');
      if (latest) {
        ctx.redactor.register(latest);
      }
      const latestAccess = stringAt(afterReuse.body, 'access_token');
      if (latestAccess) {
        ctx.redactor.register(latestAccess);
      }
    },
  );

  const dependsOn = [scenarioKey(runId, 'refresh-rotation')];

  await ctx.runner.run(
    {
      id: 'refresh-token-not-access',
      name: 'Refresh token cannot access domain endpoints',
      category: 'authentication',
      runId,
      mandatory: true,
      expected: 'GET /programs with a refresh token as Bearer -> 401',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      sc.check(session !== undefined, 'no session');
      const fresh = await registerAndLogin(ctx, sc, runId, '-b');
      const response = await ctx.api.get('/programs', fresh.refreshToken);
      sc.observe(`GET /programs with refresh token -> HTTP ${response.status}`);
      sc.check(response.status === 401, `expected 401, got ${response.status}`);
    },
  );

  await ctx.runner.run(
    {
      id: 'access-token-not-refresh',
      name: 'Access token cannot be used as refresh credential',
      category: 'authentication',
      runId,
      mandatory: true,
      expected: 'POST /auth/refresh with an access token -> 401',
      dependsOn,
    },
    async (sc: ScenarioContext) => {
      const fresh = await registerAndLogin(ctx, sc, runId, '-c');
      const response = await ctx.api.post('/auth/refresh', {
        refresh_token: fresh.accessToken,
      });
      sc.observe(
        `POST /auth/refresh with access token -> HTTP ${response.status}`,
      );
      sc.check(response.status === 401, `expected 401, got ${response.status}`);
    },
  );

  await ctx.runner.run(
    {
      id: 'domain-requires-jwt',
      name: 'Domain endpoints reject missing/invalid JWT; health is public',
      category: 'authentication',
      runId,
      mandatory: true,
      expected:
        'no token -> 401 on GET/POST /programs, GET /invoices; garbage token -> 401; /health public 200',
    },
    async (sc: ScenarioContext) => {
      const checks: [string, Promise<{ status: number }>][] = [
        ['GET /programs (no token)', ctx.api.get('/programs')],
        ['POST /programs (no token)', ctx.api.post('/programs', { name: 'x' })],
        ['GET /invoices (no token)', ctx.api.get('/invoices')],
        [
          'GET /programs (garbage token)',
          ctx.api.get('/programs', 'not-a-jwt'),
        ],
        ['POST /auth/refresh (no body)', ctx.api.post('/auth/refresh', {})],
      ];
      for (const [label, pending] of checks) {
        const { status } = await pending;
        sc.observe(`${label} -> ${status}`);
        sc.check(status === 401, `${label}: expected 401, got ${status}`);
      }
      const health = await ctx.api.get('/health');
      sc.observe(`GET /health (no token) -> ${health.status}`);
      sc.check(health.status === 200, '/health should be public');
    },
  );
}
