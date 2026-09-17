import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { HTTP_CLIENT } from '@app/modules/http/http.constants';
import { HttpClientConfig } from '@config/http.config';
import { FxRateUnavailableError } from '../exceptions/fx-rate-unavailable.error';
import { InvalidFxRateResponseError } from '../exceptions/invalid-fx-rate-response.error';
import { UnsupportedCurrencyError } from '../exceptions/unsupported-currency.error';

// Normalized, already-validated result - the only shape domain code ever sees. Raw
// Frankfurter JSON never crosses this boundary (CLAUDE.md: "Do not pass raw Frankfurter
// JSON into domain services").
export interface FrankfurterRate {
  from: string;
  to: string;
  rate: string;
  rateDate: Date;
}

// Frankfurter's actual wire shape - untrusted until validated by parseResponse().
interface FrankfurterRateResponse {
  amount?: unknown;
  base?: unknown;
  date?: unknown;
  rates?: unknown;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The only place that understands Frankfurter's external response shape
// (GET /v2/rate/{from}/{to}). Owns request construction, HTTP invocation, and upstream
// response validation/error mapping - no Invoice/business logic (CLAUDE.md).
@Injectable()
export class FrankfurterClient {
  private readonly logger = new Logger(FrankfurterClient.name);
  private readonly baseUrl: string;

  constructor(
    @Inject(HTTP_CLIENT) private readonly http: AxiosInstance,
    configService: ConfigService,
  ) {
    this.baseUrl =
      configService.getOrThrow<HttpClientConfig>('http').frankfurterBaseUrl;
  }

  async getRate(from: string, to: string): Promise<FrankfurterRate> {
    try {
      const response = await this.http.get<FrankfurterRateResponse>(
        `${this.baseUrl}/v2/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
      );

      return this.parseResponse(response.data, from, to);
    } catch (error) {
      if (
        error instanceof FxRateUnavailableError ||
        error instanceof InvalidFxRateResponseError ||
        error instanceof UnsupportedCurrencyError
      ) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;

        if (status === 404) {
          throw new UnsupportedCurrencyError(from);
        }

        if (status !== undefined && status >= 200 && status < 300) {
          // A 2xx response that axios still rejected - JSON parsing failed on an
          // otherwise-successful response, i.e. the body itself is malformed rather
          // than the request having failed.
          this.logger.error(
            `Malformed Frankfurter response for ${from}->${to}: ${toErrorMessage(error)}`,
          );
          throw new InvalidFxRateResponseError(
            `Malformed Frankfurter response for ${from}->${to}`,
          );
        }

        this.logger.error(
          `Frankfurter request failed for ${from}->${to}: ${toErrorMessage(error)}`,
        );
        throw new FxRateUnavailableError(from, to, { cause: error });
      }

      this.logger.error(
        `Unexpected Frankfurter client failure for ${from}->${to}: ${toErrorMessage(error)}`,
      );
      throw new FxRateUnavailableError(from, to, { cause: error });
    }
  }

  private parseResponse(
    data: FrankfurterRateResponse,
    from: string,
    to: string,
  ): FrankfurterRate {
    if (typeof data !== 'object' || data === null) {
      throw new InvalidFxRateResponseError(
        `Malformed Frankfurter response for ${from}->${to}`,
      );
    }

    const { base, date, rates } = data;

    if (typeof base !== 'string' || base.toUpperCase() !== from.toUpperCase()) {
      throw new InvalidFxRateResponseError(
        `Unexpected base currency in Frankfurter response for ${from}->${to}`,
      );
    }

    if (typeof date !== 'string' || date.trim().length === 0) {
      throw new InvalidFxRateResponseError(
        `Missing rate date in Frankfurter response for ${from}->${to}`,
      );
    }

    const rateDate = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(rateDate.getTime())) {
      throw new InvalidFxRateResponseError(
        `Unparseable rate date "${date}" in Frankfurter response for ${from}->${to}`,
      );
    }

    if (typeof rates !== 'object' || rates === null) {
      throw new InvalidFxRateResponseError(
        `Missing rates in Frankfurter response for ${from}->${to}`,
      );
    }

    const rateValue = (rates as Record<string, unknown>)[to.toUpperCase()];
    if (
      typeof rateValue !== 'number' ||
      !Number.isFinite(rateValue) ||
      rateValue <= 0
    ) {
      throw new InvalidFxRateResponseError(
        `Missing or invalid rate for ${from}->${to} in Frankfurter response`,
      );
    }

    return {
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      // JSON numbers at Frankfurter's realistic FX-rate precision (a handful of
      // significant digits) round-trip exactly through IEEE-754 double -> string
      // (Number.prototype.toString() uses the shortest round-tripping representation),
      // so this does not reintroduce floating-point error - the multiplication that
      // actually needs BigInt-exact arithmetic happens later, in decimal-math.ts.
      rate: rateValue.toString(),
      rateDate,
    };
  }
}
