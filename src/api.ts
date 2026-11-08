export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export class CostGraphApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CostGraphApiError';
  }
}

export interface CostGraphApiConfig {
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly baseUrl: string;
  readonly tenantId?: string;
  readonly fetch?: FetchFunction;
}

export class CostGraphApi {
  private readonly baseUrl: string;

  constructor(private readonly config: CostGraphApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  /** Resolves or rejects within `timeoutMs` even when an injected fetch ignores the abort signal. */
  post<T>(path: string, body: unknown, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
    return this.request('POST', path, body, timeoutMs, read);
  }

  get<T>(path: string, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
    return this.request('GET', path, undefined, timeoutMs, read);
  }

  put<T>(path: string, body: unknown, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
    return this.request('PUT', path, body, timeoutMs, read);
  }

  delete<T>(path: string, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
    return this.request('DELETE', path, undefined, timeoutMs, read);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CostGraphApiError(`${path} timed out after ${timeoutMs}ms`, undefined, true));
      }, timeoutMs);
      unrefTimer(timer);
    });
    const request = this.send(method, path, body, controller.signal).then(read);
    request.catch(() => {});
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(method: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;
    if (this.config.accessToken) headers.Authorization = `Bearer ${this.config.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.config.tenantId) headers['X-CostGraph-Tenant-ID'] = this.config.tenantId;

    let response: Response;
    try {
      response = await (this.config.fetch ?? globalThis.fetch)(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new CostGraphApiError(`${path} request failed: ${errorMessage(error)}`, undefined, true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const message = (await readErrorMessage(response)) ?? `${path} returned HTTP ${response.status}`;
      throw new CostGraphApiError(message, response.status, retryable);
    }
    return response;
  }
}

export async function readData(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CostGraphApiError('response is not valid JSON');
  }
  if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
    throw new CostGraphApiError('response has no data field');
  }
  return payload.data;
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!isRecord(payload)) return undefined;
  return typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lets Node exit while background work is pending; a no-op in runtimes without unref. */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
