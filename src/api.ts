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
  readonly apiKey: string;
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
  async post<T>(path: string, body: unknown, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CostGraphApiError(`${path} timed out after ${timeoutMs}ms`, undefined, true));
      }, timeoutMs);
      unrefTimer(timer);
    });
    const request = this.send(path, body, controller.signal).then(read);
    request.catch(() => {});
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.config.tenantId) headers['X-CostGraph-Tenant-ID'] = this.config.tenantId;

    let response: Response;
    try {
      response = await (this.config.fetch ?? globalThis.fetch)(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new CostGraphApiError(`${path} request failed: ${errorMessage(error)}`, undefined, true);
    }
    if (!response.ok) {
      void discardBody(response);
      const retryable = response.status === 429 || response.status >= 500;
      throw new CostGraphApiError(`${path} returned HTTP ${response.status}`, response.status, retryable);
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
