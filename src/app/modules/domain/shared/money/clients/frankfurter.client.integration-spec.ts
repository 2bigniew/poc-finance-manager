import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FxRateUnavailableError } from '../exceptions/fx-rate-unavailable.error';
import { InvalidFxRateResponseError } from '../exceptions/invalid-fx-rate-response.error';
import { UnsupportedCurrencyError } from '../exceptions/unsupported-currency.error';
import { FrankfurterClient } from './frankfurter.client';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

function buildConfigService(baseUrl: string): ConfigService {
  return {
    getOrThrow: () => ({ frankfurterBaseUrl: baseUrl, timeoutMs: 2_000 }),
  } as unknown as ConfigService;
}

// Exercises the real Axios client configuration (HttpModule's axios.create({ timeout }))
// against a controlled local HTTP server standing in for Frankfurter - never the live
// service (TESTING.md: "Normal automated tests MUST NOT call the live Frankfurter
// service... Use a controlled HTTP server for Axios/Frankfurter integration tests").
describe('FrankfurterClient (Axios integration)', () => {
  let server: Server;
  let baseUrl: string;
  let handler: RequestHandler;

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function buildClient(timeoutMs = 2_000): FrankfurterClient {
    const http = axios.create({ timeout: timeoutMs });
    return new FrankfurterClient(http, buildConfigService(baseUrl));
  }

  function respondJson(
    res: ServerResponse,
    status: number,
    body: unknown,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  it('requests the correct base URL/path and maps a valid response', async () => {
    let requestedPath: string | undefined;
    handler = (req, res) => {
      requestedPath = req.url;
      respondJson(res, 200, {
        base: 'EUR',
        quote: 'USD',
        date: '2026-01-15',
        rate: 1.0834,
      });
    };

    const result = await buildClient().getRate('EUR', 'USD');

    expect(requestedPath).toBe('/v2/rate/EUR/USD');
    expect(result).toEqual({
      from: 'EUR',
      to: 'USD',
      rate: '1.0834',
      rateDate: new Date('2026-01-15T00:00:00.000Z'),
    });
  });

  it('maps a 404 response to UnsupportedCurrencyError', async () => {
    handler = (req, res) => {
      respondJson(res, 404, { message: 'not found' });
    };

    await expect(buildClient().getRate('ZZZ', 'USD')).rejects.toBeInstanceOf(
      UnsupportedCurrencyError,
    );
  });

  it('maps a 5xx response to FxRateUnavailableError', async () => {
    handler = (req, res) => {
      res.writeHead(500);
      res.end('internal error');
    };

    await expect(buildClient().getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it('maps a malformed JSON body to InvalidFxRateResponseError', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json{{{');
    };

    await expect(buildClient().getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      InvalidFxRateResponseError,
    );
  });

  it('maps a response missing the requested rate to InvalidFxRateResponseError', async () => {
    handler = (req, res) => {
      respondJson(res, 200, {
        base: 'EUR',
        quote: 'USD',
        date: '2026-01-15',
      });
    };

    await expect(buildClient().getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      InvalidFxRateResponseError,
    );
  });

  it('maps a zero rate to InvalidFxRateResponseError', async () => {
    handler = (req, res) => {
      respondJson(res, 200, {
        base: 'EUR',
        quote: 'USD',
        date: '2026-01-15',
        rate: 0,
      });
    };

    await expect(buildClient().getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      InvalidFxRateResponseError,
    );
  });

  it('maps a response with an unexpected base currency to InvalidFxRateResponseError', async () => {
    handler = (req, res) => {
      respondJson(res, 200, {
        base: 'GBP',
        quote: 'USD',
        date: '2026-01-15',
        rate: 1.2,
      });
    };

    await expect(buildClient().getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      InvalidFxRateResponseError,
    );
  });

  it('maps a response with an unexpected quote currency to InvalidFxRateResponseError', async () => {
    handler = (req, res) => {
      respondJson(res, 200, {
        base: 'EUR',
        quote: 'GBP',
        date: '2026-01-15',
        rate: 1.2,
      });
    };

    await expect(buildClient().getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      InvalidFxRateResponseError,
    );
  });

  it('maps a request timeout to FxRateUnavailableError', async () => {
    handler = () => {
      // Never respond - forces the client's configured timeout to fire.
    };

    await expect(buildClient(200).getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  }, 10_000);

  it('maps a connection failure to FxRateUnavailableError', async () => {
    const http = axios.create({ timeout: 2_000 });
    const client = new FrankfurterClient(
      http,
      buildConfigService('http://127.0.0.1:1'),
    );

    await expect(client.getRate('EUR', 'USD')).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it('never leaks a raw AxiosError to the caller', async () => {
    handler = (req, res) => {
      res.writeHead(500);
      res.end('boom');
    };

    await expect(
      buildClient().getRate('EUR', 'USD'),
    ).rejects.not.toHaveProperty('isAxiosError', true);
  });
});
