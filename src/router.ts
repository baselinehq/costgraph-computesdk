import type { InstanceSizeClass } from 'computesdk';
import { CostGraphApiError, isRecord, readData, type CostGraphApi } from './api.js';

const ROUTE_PATH = '/api/v1/tenant/sandboxes/route';
const ROUTE_REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_TTL_MS = 30_000;

export interface RouteDecision {
  readonly decisionId?: string;
  readonly order: readonly string[];
  readonly exceededBudget?: string;
}

interface CachedAnswer {
  readonly decision: RouteDecision | undefined;
  readonly expiresAt: number;
}

export class Router {
  private readonly cache = new Map<string, CachedAnswer>();
  private readonly inflight = new Map<string, Promise<RouteDecision | undefined>>();
  private enforcedBudget = false;

  constructor(
    private readonly api: CostGraphApi,
    private readonly timeoutMs: number,
    private readonly cacheTtlMs: number,
    private readonly reportError: (error: unknown) => void,
  ) {}

  get enforcesBudget(): boolean {
    return this.enforcedBudget;
  }

  /**
   * Never rejects. Waits at most the route timeout, or the request timeout while the team enforces a budget. Undefined means no answer.
   * A slow answer keeps loading after the caller gives up so the next create can use it from the cache.
   */
  async route(sizeClass: InstanceSizeClass | undefined, providers: readonly string[]): Promise<RouteDecision | undefined> {
    const key = JSON.stringify([sizeClass ?? null, providers]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.decision;
    if (cached) this.cache.delete(key);

    const waitMs = this.enforcedBudget ? Math.max(this.timeoutMs, ROUTE_REQUEST_TIMEOUT_MS) : this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        this.reportError(new CostGraphApiError(`no routing answer within ${waitMs}ms`));
        resolve(undefined);
      }, waitMs);
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
      .then((data) => {
        this.recordBudgetEnforcement(data);
        return parseDecision(data);
      })
      .then(
        (decision) => {
          if (decision.exceededBudget === undefined) {
            this.cache.set(key, { decision, expiresAt: Date.now() + this.cacheTtlMs });
          }
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

  private recordBudgetEnforcement(data: unknown): void {
    if (isRecord(data) && typeof data.enforced_budget === 'boolean') this.enforcedBudget = data.enforced_budget;
  }
}

function parseDecision(data: unknown): RouteDecision {
  if (!isRecord(data)) throw new CostGraphApiError('route response data is not an object');
  const { decision_id: decisionId, provider, order, reason, budget_name: budgetName } = data;
  if (reason === 'budget_exceeded') {
    return { order: [], exceededBudget: typeof budgetName === 'string' ? budgetName : '' };
  }
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
