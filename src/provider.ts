import {
  INSTANCE_SIZE_PROFILES,
  InstanceSizeError,
  assertInstanceSizeSupported,
  getInstanceSizeProfile,
  hasInstanceSizeRequest,
  isInstanceSizeManager,
  validateInstanceSizeOptions,
  type CreateInstanceOptions,
  type CreateVolumeOptions,
  type ExplicitComputeConfig,
  type InstanceInterface,
  type InstanceSizeClass,
  type InstanceSizeManager,
  type InstanceSizeResolution,
  type InstanceSizeStatus,
  type ListVolumesOptions,
  type Volume,
} from 'computesdk';
import { CostGraphApi, errorMessage, type FetchFunction } from './api.js';
import { EventReporter, sanitizeMetadata, type StartedSize } from './events.js';
import { Router, orderByDecision, type RouteDecision } from './router.js';
import { applySizeOptions, isExactSize, mapSize, type SupportedSizeMapping } from './sizes.js';

const PROVIDER_NAME = 'costgraph';
const DEFAULT_BASE_URL = 'https://api.costgraph.ai';
const DEFAULT_ROUTE_TIMEOUT_MS = 300;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/** The provider shape `compute.setConfig({ provider })` accepts. */
export type DirectProvider = NonNullable<ExplicitComputeConfig['provider']>;
type InstanceManager = NonNullable<DirectProvider['instances']>;
type SnapshotManager = NonNullable<DirectProvider['snapshot']>;
type VolumeManager = NonNullable<DirectProvider['volume']>;
type Snapshot = Awaited<ReturnType<SnapshotManager['create']>>;
type UnresolvedSizeStatus = Exclude<InstanceSizeStatus, 'supported'>;

export interface CostGraphOptions {
  /** When empty, sandboxes are created in the team's list order and nothing is reported. */
  apiKey: string | undefined;
  /** The team's ComputeSDK providers, identified by `name`. List order is the fallback order. */
  providers: readonly DirectProvider[];
  /** Defaults to https://api.costgraph.ai. */
  baseUrl?: string;
  /** Sent as `X-CostGraph-Tenant-ID`. */
  tenantId?: string;
  /** Longest a create waits for a routing answer before using list order. Defaults to 300. */
  routeTimeoutMs?: number;
  /** How long a routing answer is reused for the same size and provider list. Defaults to 5 minutes. */
  cacheTtlMs?: number;
  /** Defaults to the global fetch. */
  fetch?: FetchFunction;
  /** Receives CostGraph failures. They never reach sandbox calls. Defaults to ignoring them. */
  onError?: (error: unknown) => void;
  /** Same meaning as ComputeSDK's `fallbackOnError`, which `compute.setConfig` cannot pass to a provider. Defaults to true. */
  fallbackOnError?: boolean;
}

export interface CostGraphProvider {
  readonly name: typeof PROVIDER_NAME;
  readonly sizes: InstanceSizeManager;
  readonly instances: Required<InstanceManager>;
  readonly snapshot?: SnapshotManager;
  readonly volume?: VolumeManager;
  /** Sends the queued sandbox events. Await it before the process exits. Resolves within `timeoutMs` (default 10 s) and never rejects. */
  flush(timeoutMs?: number): Promise<void>;
}

interface WrappedProvider {
  readonly name: string;
  readonly provider: DirectProvider;
  readonly instances: InstanceManager;
}

/** Without a mapping the provider creates the size itself, or the create has no size. */
interface CreateTarget {
  readonly provider: WrappedProvider;
  readonly sizeMapping?: SupportedSizeMapping;
}

const UNRESOLVED_SIZE_STATUSES: ReadonlySet<string> = new Set<UnresolvedSizeStatus>([
  'unknown',
  'unsupported',
  'unconfigured',
  'unavailable',
  'requires-build',
]);

export function costgraph(options: CostGraphOptions): CostGraphProvider {
  return new CostGraphRoutingProvider(options);
}

class CostGraphRoutingProvider implements CostGraphProvider {
  readonly name = PROVIDER_NAME;
  readonly sizes: InstanceSizeManager;
  readonly instances: Required<InstanceManager>;
  readonly snapshot?: SnapshotManager;
  readonly volume?: VolumeManager;

  private readonly providers: readonly WrappedProvider[];
  private readonly providersByName: ReadonlyMap<string, WrappedProvider>;
  private readonly instanceOwners = new Map<string, WrappedProvider>();
  private readonly snapshotOwners = new Map<string, WrappedProvider>();
  private readonly volumeOwners = new Map<string, WrappedProvider>();
  private readonly reportError: (error: unknown) => void;
  private readonly router: Router | undefined;
  private readonly events: EventReporter | undefined;
  private readonly fallbackOnError: boolean;

  constructor(options: CostGraphOptions) {
    this.providers = wrapProviders(options.providers);
    this.providersByName = new Map(this.providers.map((provider) => [provider.name, provider]));
    this.reportError = isolateErrorHandler(options.onError);
    this.fallbackOnError = options.fallbackOnError ?? true;

    if (options.apiKey) {
      const api = new CostGraphApi({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        tenantId: options.tenantId,
        fetch: options.fetch,
      });
      this.router = new Router(
        api,
        durationOption(options.routeTimeoutMs, DEFAULT_ROUTE_TIMEOUT_MS),
        durationOption(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS),
        this.reportError,
      );
      this.events = new EventReporter(api, this.reportError);
    } else {
      this.reportError(new Error('CostGraph apiKey is not set: creating sandboxes in list order and reporting nothing'));
    }

    this.sizes = combinedSizeManager(this.providers);
    this.instances = {
      create: (createOptions) => this.create(createOptions),
      getById: (instanceId) => this.getById(instanceId),
      list: () => this.list(),
      destroy: (instanceId) => this.destroy(instanceId),
    };
    if (this.providers.some((provider) => provider.provider.snapshot)) this.snapshot = this.snapshotManager();
    if (this.providers.some((provider) => provider.provider.volume)) this.volume = this.volumeManager();
  }

  flush(timeoutMs?: number): Promise<void> {
    return this.events?.flush(timeoutMs) ?? Promise.resolve();
  }

  private async create(options: CreateInstanceOptions = {}): Promise<InstanceInterface> {
    if (hasInstanceSizeRequest(options)) validateInstanceSizeOptions(options);
    // Same routing-only keys ComputeSDK strips before calling a provider; strict vendors reject them.
    const { provider: requestedName, kind: _kind, ...createOptions } = options;
    const sizeClass: InstanceSizeClass | undefined = createOptions.sizeClass;
    const pinned =
      typeof requestedName === 'string' ? this.providerNamed(requestedName) : this.ownerOfReferencedResources(createOptions);
    const pool = pinned ? [pinned] : this.providers;
    const eligible: CreateTarget[] =
      sizeClass === undefined
        ? pool.map((provider) => ({ provider }))
        : preferExactSizes(supportingSize(pool, sizeClass, createOptions), sizeClass);
    const names = eligible.map((target) => target.provider.name);
    const decision = eligible.length > 1 ? await this.router?.route(sizeClass, names) : undefined;
    const targets = new Map(eligible.map((target) => [target.provider.name, target]));
    const ordered = orderByDecision(names, decision?.order).flatMap((name) => targets.get(name) ?? []);
    // Mirrors ComputeSDK: a pinned provider or a defined sizeClass never reroutes after a create attempt.
    const canReroute = this.fallbackOnError && pinned === undefined && sizeClass === undefined;
    const failures: Array<{ provider: WrappedProvider; error: unknown }> = [];

    for (const { provider: target, sizeMapping } of ordered) {
      let instance: InstanceInterface;
      try {
        instance = await target.instances.create(
          sizeMapping ? applySizeOptions(createOptions, sizeMapping) : createOptions,
        );
        assertEgressHonored(instance, target, createOptions);
      } catch (error) {
        if (!canReroute || !mayReroute(error)) throw error;
        failures.push({ provider: target, error });
        continue;
      }
      return this.adopt(instance, target, decision, startedSize(sizeClass, sizeMapping), createOptions.metadata);
    }

    throw new AggregateError(
      failures.map(({ error }) => error),
      `Failed to create instance across ${ordered.length} provider(s).\n` +
        failures.map(({ provider, error }) => `- ${provider.name}: ${errorMessage(error)}`).join('\n'),
    );
  }

  private async getById(instanceId: string): Promise<InstanceInterface | null> {
    const known = this.instanceOwners.get(instanceId);
    if (!known) {
      const found = await this.discover(instanceId);
      return found ? this.track(found.instance, found.owner) : null;
    }
    const instance = await known.instances.getById(instanceId);
    if (!instance) {
      this.instanceOwners.delete(instanceId);
      return null;
    }
    return this.track(instance, known);
  }

  private async list(): Promise<InstanceInterface[]> {
    const all: InstanceInterface[] = [];
    for (const owner of this.providers) {
      if (!owner.instances.list) continue;
      for (const instance of await owner.instances.list()) {
        const instanceId = instanceIdOf(instance);
        if (instanceId !== undefined) this.instanceOwners.set(instanceId, owner);
        all.push(this.track(instance, owner));
      }
    }
    return all;
  }

  private async destroy(instanceId: string): Promise<void> {
    const owner = this.instanceOwners.get(instanceId) ?? (await this.discover(instanceId))?.owner;
    if (!owner) {
      await firstSuccess(`destroy instance "${instanceId}"`, this.providers, (provider) =>
        provider.instances.destroy(instanceId),
      );
      return;
    }
    await owner.instances.destroy(instanceId);
    this.recordStop(owner, instanceId);
  }

  private snapshotManager(): SnapshotManager {
    return {
      create: async (instanceId, options) => {
        const owner = this.instanceOwners.get(instanceId) ?? (await this.discover(instanceId))?.owner;
        if (!owner) throw new Error(`Instance "${instanceId}" was not found on any configured provider`);
        const snapshot = await snapshotsOf(owner).create(instanceId, options);
        this.snapshotOwners.set(snapshot.id, owner);
        return snapshot;
      },
      list: async () => {
        const all: Snapshot[] = [];
        for (const owner of this.providers) {
          if (!owner.provider.snapshot) continue;
          for (const snapshot of await owner.provider.snapshot.list()) {
            this.snapshotOwners.set(snapshot.id, owner);
            all.push(snapshot);
          }
        }
        return all;
      },
      delete: async (snapshotId) => {
        const known = this.snapshotOwners.get(snapshotId);
        const candidates = known ? [known] : this.providers.filter((provider) => provider.provider.snapshot);
        await firstSuccess(`delete snapshot "${snapshotId}"`, candidates, (provider) =>
          snapshotsOf(provider).delete(snapshotId),
        );
        this.snapshotOwners.delete(snapshotId);
      },
    };
  }

  private volumeManager(): VolumeManager {
    return {
      create: async (options) => {
        const { provider: requestedName, ...volumeOptions } = options as CreateVolumeOptions & { provider?: unknown };
        const candidates =
          typeof requestedName === 'string'
            ? [this.providerNamed(requestedName)]
            : this.providers.filter((provider) => provider.provider.volume);
        const [owner, volume] = await firstSuccess(`create volume "${volumeOptions.name}"`, candidates, (provider) =>
          volumesOf(provider).create(volumeOptions),
        );
        this.recordVolume(volume, owner);
        return volume;
      },
      get: async (volumeIdOrName) => {
        const known = this.volumeOwners.get(volumeIdOrName);
        for (const owner of known ? [known] : this.providers) {
          if (!owner.provider.volume) continue;
          const volume = await owner.provider.volume.get(volumeIdOrName);
          if (volume) {
            this.volumeOwners.set(volumeIdOrName, owner);
            return volume;
          }
        }
        return null;
      },
      list: async (options?: ListVolumesOptions) => {
        const all: Volume[] = [];
        for (const owner of this.providers) {
          if (!owner.provider.volume) continue;
          let listed: Volume[];
          try {
            listed = await owner.provider.volume.list(options);
          } catch (error) {
            // Same skip rule as ComputeSDK: only providers without a list API are passed over.
            if (/does not support listing/i.test(errorMessage(error))) continue;
            throw error;
          }
          for (const volume of listed) {
            this.recordVolume(volume, owner);
            all.push({ provider: owner.name, ...volume });
          }
        }
        return all;
      },
      delete: async (volumeIdOrName) => {
        const known = this.volumeOwners.get(volumeIdOrName);
        const candidates = known ? [known] : this.providers.filter((provider) => provider.provider.volume);
        await firstSuccess(`delete volume "${volumeIdOrName}"`, candidates, (provider) =>
          volumesOf(provider).delete(volumeIdOrName),
        );
        this.volumeOwners.delete(volumeIdOrName);
      },
    };
  }

  private providerNamed(name: string): WrappedProvider {
    const provider = this.providersByName.get(name);
    if (!provider) {
      const names = this.providers.map((configured) => configured.name).join(', ');
      throw new Error(`Provider "${name}" is not configured. Configured providers: ${names}.`);
    }
    return provider;
  }

  /** Snapshots and volumes live on one vendor, so a create that uses them must go there. */
  private ownerOfReferencedResources(options: CreateInstanceOptions): WrappedProvider | undefined {
    if (typeof options.snapshotId === 'string') {
      const owner = this.snapshotOwners.get(options.snapshotId);
      if (owner) return owner;
    }
    for (const mount of Array.isArray(options.volumes) ? options.volumes : []) {
      const volume: unknown = mount?.volume;
      const reference =
        typeof volume === 'string' ? volume : isRecord(volume) ? (volume.id ?? volume.name) : undefined;
      const owner = typeof reference === 'string' ? this.volumeOwners.get(reference) : undefined;
      if (owner) return owner;
    }
    return undefined;
  }

  private async discover(instanceId: string): Promise<{ owner: WrappedProvider; instance: InstanceInterface } | undefined> {
    for (const owner of this.providers) {
      let instance: InstanceInterface | null;
      try {
        instance = await owner.instances.getById(instanceId);
      } catch {
        continue;
      }
      if (instance) {
        this.instanceOwners.set(instanceId, owner);
        return { owner, instance };
      }
    }
    return undefined;
  }

  /** Bookkeeping after a successful create must never fail or reroute it. */
  private adopt(
    instance: InstanceInterface,
    owner: WrappedProvider,
    decision: RouteDecision | undefined,
    size: StartedSize,
    metadata: unknown,
  ): InstanceInterface {
    try {
      const instanceId = instanceIdOf(instance);
      if (instanceId === undefined) return instance;
      this.instanceOwners.set(instanceId, owner);
      this.events?.push({
        type: 'started',
        provider: owner.name,
        sandbox_id: instanceId,
        at: new Date().toISOString(),
        decision_id: decision?.decisionId,
        ...size,
        metadata: sanitizeMetadata(metadata),
      });
      return this.track(instance, owner);
    } catch (error) {
      this.reportError(error);
      return instance;
    }
  }

  private recordStop(owner: WrappedProvider, instanceId: string): void {
    this.instanceOwners.delete(instanceId);
    this.events?.push({ type: 'stopped', provider: owner.name, sandbox_id: instanceId, at: new Date().toISOString() });
  }

  private recordVolume(volume: Volume, owner: WrappedProvider): void {
    if (volume.id) this.volumeOwners.set(volume.id, owner);
    if (volume.name) this.volumeOwners.set(volume.name, owner);
  }

  /** Reports the stop when the caller destroys through the instance itself rather than compute.instances. */
  private track(instance: InstanceInterface, owner: WrappedProvider): InstanceInterface {
    const instanceId = instanceIdOf(instance);
    if (instanceId === undefined || isFixedProperty(instance, 'destroy')) return instance;
    const methods = new Map<PropertyKey, { readonly source: unknown; readonly method: unknown }>();
    // The real instance is the receiver throughout, so classes with #private fields keep working.
    return new Proxy(instance, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function' || isFixedProperty(target, property)) return value;
        const cached = methods.get(property);
        if (cached?.source === value) return cached.method;
        const method =
          property === 'destroy'
            ? async (...args: unknown[]) => {
                await value.apply(target, args);
                this.recordStop(owner, instanceId);
              }
            : value.bind(target);
        methods.set(property, { source: value, method });
        return method;
      },
      set: (target, property, value) => Reflect.set(target, property, value, target),
    });
  }
}

function wrapProviders(providers: readonly DirectProvider[]): WrappedProvider[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new TypeError('costgraph() needs at least one ComputeSDK provider in `providers`');
  }
  const seen = new Set<string>();
  return providers.map((provider: DirectProvider, index) => {
    const instances = provider?.instances ?? provider?.sandbox;
    if (
      !instances ||
      typeof instances.create !== 'function' ||
      typeof instances.getById !== 'function' ||
      typeof instances.destroy !== 'function'
    ) {
      throw new TypeError(`providers[${index}] is not a ComputeSDK provider`);
    }
    const name = provider.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`providers[${index}] has no name; CostGraph identifies providers by name`);
    }
    if (seen.has(name)) throw new TypeError(`Provider "${name}" is listed more than once`);
    seen.add(name);
    return { name, provider, instances };
  });
}

/**
 * Supported when any wrapped provider maps the size itself or CostGraph maps it to that vendor's own options.
 * ComputeSDK accepts only a resolution equal to the request, so a larger vendor tier is reported in the started event instead.
 */
function combinedSizeManager(providers: readonly WrappedProvider[]): InstanceSizeManager {
  const resolve = (sizeClass: InstanceSizeClass, options?: CreateInstanceOptions): InstanceSizeResolution => {
    if (options?.sizeClass !== undefined && options.sizeClass !== sizeClass) {
      throw new InstanceSizeError('conflict', 'resolve size differs from options.sizeClass');
    }
    return resolveAcross(providers, sizeClass, options).resolution;
  };
  return Object.freeze({
    contract: 'computesdk.instance-sizes.v1' as const,
    resolve,
    list: (options?: CreateInstanceOptions) =>
      Object.freeze(
        Object.values(INSTANCE_SIZE_PROFILES).map((profile) =>
          resolve(profile.sizeClass, options ? { ...options, sizeClass: undefined } : undefined),
        ),
      ),
  });
}

function supportingSize(
  providers: readonly WrappedProvider[],
  sizeClass: InstanceSizeClass,
  options: CreateInstanceOptions,
): CreateTarget[] {
  const { supported, resolution } = resolveAcross(providers, sizeClass, options);
  if (resolution.status !== 'supported') throw new InstanceSizeError(resolution.status, resolution.reason, resolution);
  return supported;
}

function resolveAcross(
  providers: readonly WrappedProvider[],
  sizeClass: InstanceSizeClass,
  options?: CreateInstanceOptions,
): { supported: CreateTarget[]; resolution: InstanceSizeResolution } {
  const requested = getInstanceSizeProfile(sizeClass);
  const request = { ...options, sizeClass };
  const supported: CreateTarget[] = [];
  const refusals: Array<{ provider: WrappedProvider; status: UnresolvedSizeStatus; reason: string }> = [];

  for (const provider of providers) {
    try {
      assertInstanceSizeSupported(provider.provider, request);
      supported.push({ provider });
    } catch (error) {
      if (!(error instanceof InstanceSizeError) || !isUnresolvedStatus(error.code)) throw error;
      const sizeMapping = hasNoSizeMapping(provider, error) ? mapSize(provider.name, requested, request) : undefined;
      if (sizeMapping?.status === 'supported') {
        supported.push({ provider, sizeMapping });
        continue;
      }
      const reason =
        sizeMapping?.reason ??
        (error.resolution && 'reason' in error.resolution ? error.resolution.reason : error.message);
      refusals.push({ provider, status: sizeMapping?.status ?? error.code, reason: reason.replace(/^sizeClass: /, '') });
    }
  }

  if (supported.length > 0) {
    return {
      supported,
      resolution: Object.freeze({
        requested,
        provenance: 'adapter-declared',
        status: 'supported',
        resolved: Object.freeze({ vcpus: requested.vcpus, memoryMiB: requested.memoryMiB }),
        nativeOptions: Object.freeze({}),
      }),
    };
  }
  return {
    supported,
    resolution: Object.freeze({
      requested,
      provenance: 'adapter-declared',
      status: refusals[0].status,
      reason: refusals.map(({ provider, reason }) => `${provider.name}: ${reason}`).join('; '),
    }),
  };
}

/** CostGraph's own mapping never replaces a mapping the adapter declares, even an invalid one. */
function hasNoSizeMapping(provider: WrappedProvider, error: InstanceSizeError): boolean {
  if (!isInstanceSizeManager(provider.provider.sizes)) return true;
  return error.resolution !== undefined && error.resolution.status === 'unknown';
}

/**
 * CostGraph prices every candidate at the requested size, so a vendor whose smallest fitting tier is larger
 * would look cheaper than it runs. It is only a candidate when no provider creates the exact size.
 */
function preferExactSizes(targets: CreateTarget[], sizeClass: InstanceSizeClass): CreateTarget[] {
  const requested = getInstanceSizeProfile(sizeClass);
  const exact = targets.filter(({ sizeMapping }) => !sizeMapping || isExactSize(sizeMapping, requested));
  return exact.length > 0 ? exact : targets;
}

/** CostGraph prefers size_class over vcpus and memory_mib, so a larger vendor tier is never reported as the requested size. */
function startedSize(sizeClass: InstanceSizeClass | undefined, sizeMapping: SupportedSizeMapping | undefined): StartedSize {
  if (sizeClass === undefined) return {};
  if (!sizeMapping || isExactSize(sizeMapping, getInstanceSizeProfile(sizeClass))) return { size_class: sizeClass };
  return { vcpus: sizeMapping.vcpus, memory_mib: sizeMapping.memoryMiB };
}

function isUnresolvedStatus(code: string): code is UnresolvedSizeStatus {
  return UNRESOLVED_SIZE_STATUSES.has(code);
}

/** ComputeSDK's own rule: aborts and errors marked `fallback: false` never move to another provider. */
function mayReroute(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.name !== 'AbortError' && (error as { fallback?: unknown }).fallback !== false;
}

async function firstSuccess<T>(
  action: string,
  candidates: readonly WrappedProvider[],
  attempt: (provider: WrappedProvider) => Promise<T>,
): Promise<[WrappedProvider, T]> {
  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      return [provider, await attempt(provider)];
    } catch (error) {
      failures.push(`- ${provider.name}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`Failed to ${action} across ${candidates.length} provider(s).\n${failures.join('\n')}`);
}

function snapshotsOf(provider: WrappedProvider): SnapshotManager {
  if (!provider.provider.snapshot) throw new Error(`Provider "${provider.name}" does not support snapshots`);
  return provider.provider.snapshot;
}

function volumesOf(provider: WrappedProvider): VolumeManager {
  if (!provider.provider.volume) throw new Error(`Provider "${provider.name}" does not support volumes`);
  return provider.provider.volume;
}

function instanceIdOf(instance: InstanceInterface): string | undefined {
  if (typeof instance.instanceId === 'string') return instance.instanceId;
  return typeof instance.sandboxId === 'string' ? instance.sandboxId : undefined;
}

/** ComputeSDK's own check: an instance that ignored a requested egress router is destroyed, not returned. */
function assertEgressHonored(instance: InstanceInterface, owner: WrappedProvider, options: CreateInstanceOptions): void {
  const egress: unknown = options.egress;
  if (!isRecord(egress) || Array.isArray(egress) || instance.egress) return;
  const instanceId = instanceIdOf(instance);
  if (instanceId !== undefined) owner.instances.destroy(instanceId).catch(() => {});
  throw new Error(`egress: provider "${owner.name}" does not support the "egress" option`);
}

/** A Proxy must return the exact value of a non-configurable, non-writable property. */
function isFixedProperty(target: object, property: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  return descriptor !== undefined && !descriptor.configurable && descriptor.writable === false;
}

const MAX_TIMER_MS = 2_147_483_647;

function durationOption(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, MAX_TIMER_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** A throwing or rejecting onError must never reach a sandbox call. */
function isolateErrorHandler(onError: ((error: unknown) => void) | undefined): (error: unknown) => void {
  if (!onError) return () => {};
  return (error) => {
    void Promise.resolve()
      .then(() => onError(error))
      .catch(() => {});
  };
}
