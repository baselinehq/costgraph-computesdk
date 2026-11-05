import type { InstanceSizeClass } from 'computesdk';
import { CostGraphApiError, readData, type CostGraphApi } from './api.js';

const ROUTE_PATH = '/api/v1/tenant/sandboxes/route';
const ROUTE_REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_TTL_MS = 30_000;

export interface RouteDecision {
  readonly decisionId?: string;
  readonly order: readonly string[];
}

interface CachedAnswer {
  readonly decision: RouteDecision | undefined;
  readonly expiresAt: number;
}

export class Router {
  private readonly cache = new Map<string, CachedAnswer>();
  private readonly inflight = new Map<string, Promise<RouteDecision | undefined>>();

  constructor(
    private readonly api: CostGraphApi,
    private readonly timeoutMs: number,
    private readonly cacheTtlMs: number,
    private readonly reportError: (error: unknown) => void,
  ) {}

  /**
   * Never rejects and never waits longer than the route timeout. Undefined means "use the team's list order".
   * A slow answer keeps loading after the caller gives up so the next create can use it from the cache.
   */
  async route(sizeClass: InstanceSizeClass | undefined, providers: readonly string[]): Promise<RouteDecision | undefined> {
    const key = JSON.stringify([sizeClass ?? null, providers]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.decision;
    if (cached) this.cache.delete(key);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        this.reportError(new CostGraphApiError(`no routing answer within ${this.timeoutMs}ms; using list order`));
        resolve(undefined);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.request(key, sizeClass, providers), gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  private request(
    key: string,
    sizeClass: InstanceSizeClass | undefined,
    providers: readonly string[],
  ): Promise<RouteDecision | undefined> {
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const body = sizeClass === undefined ? { providers } : { size_class: sizeClass, providers };
    const request = this.api
      .post(ROUTE_PATH, body, Math.max(this.timeoutMs, ROUTE_REQUEST_TIMEOUT_MS), readData)
      .then(parseDecision)
      .then(
        (decision) => {
          this.cache.set(key, { decision, expiresAt: Date.now() + this.cacheTtlMs });
          return decision;
        },
        (error: unknown) => {
          this.cache.set(key, { decision: undefined, expiresAt: Date.now() + Math.min(FAILURE_TTL_MS, this.cacheTtlMs) });
          this.reportError(error);
          return undefined;
        },
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }
}

function parseDecision(data: unknown): RouteDecision {
  if (data === null || typeof data !== 'object') throw new CostGraphApiError('route response data is not an object');
  const { decision_id: decisionId, provider, order } = data as Record<string, unknown>;
  const names = Array.isArray(order) ? order.filter((name): name is string => typeof name === 'string') : [];
  if (names.length === 0 && typeof provider === 'string') names.push(provider);
  if (names.length === 0) throw new CostGraphApiError('route response names no provider');
  return { decisionId: typeof decisionId === 'string' ? decisionId : undefined, order: names };
}

/** Ignores names the team did not configure and appends configured providers the answer left out. */
export function orderByDecision(configured: readonly string[], preferred: readonly string[] = []): string[] {
  const allowed = new Set(configured);
  const ordered = new Set(preferred.filter((name) => allowed.has(name)));
  for (const name of configured) ordered.add(name);
  return [...ordered];
}
