import axios, { AxiosInstance } from 'axios';

export interface ApiResponse {
  method: string;
  path: string;
  status: number;
  body: unknown;
  startedAt: number;
  finishedAt: number;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// Black-box HTTP access to the running application. Non-2xx responses are returned,
// never thrown, so scenarios can assert on expected failures. Network errors become
// status 0 with only the error message - request config (and so the Authorization
// header) never leaves this function.
export class ApiClient {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, timeoutMs: number) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      validateStatus: () => true,
    });
  }

  async request(
    method: HttpMethod,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<ApiResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.http.request<unknown>({
        method,
        url: path,
        data: options.body,
        headers:
          options.token === undefined
            ? {}
            : { Authorization: `Bearer ${options.token}` },
      });
      return {
        method,
        path,
        status: response.status,
        body: response.data,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (error) {
      return {
        method,
        path,
        status: 0,
        body: {
          networkError: error instanceof Error ? error.message : String(error),
        },
        startedAt,
        finishedAt: Date.now(),
      };
    }
  }

  get(path: string, token?: string): Promise<ApiResponse> {
    return this.request('GET', path, { token });
  }

  post(path: string, body: unknown, token?: string): Promise<ApiResponse> {
    return this.request('POST', path, { token, body });
  }
}
