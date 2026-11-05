import type { CreateInstanceOptions, InstanceSizeProfile } from 'computesdk';

type VendorOptions = Readonly<Record<string, unknown>>;

interface VendorTier {
  readonly vcpus: number;
  readonly memoryMiB: number;
  readonly options: VendorOptions;
}

interface VendorSizing {
  readonly source: string;
  /** Create option the vendor needs before it accepts CPU and memory. */
  readonly requiredOption?: string;
  /** Create options with which the vendor refuses CPU and memory. */
  readonly excludedOptions?: readonly string[];
  /** Ascending, so the first tier that fits is the smallest. */
  readonly tiers: readonly VendorTier[];
}

export interface SupportedSizeMapping {
  readonly status: 'supported';
  readonly vcpus: number;
  readonly memoryMiB: number;
  readonly options: VendorOptions;
}

export type SizeMapping = SupportedSizeMapping | { readonly status: 'unsupported' | 'unconfigured'; readonly reason: string };

function tier(vcpus: number, memoryMiB: number, options: VendorOptions): VendorTier {
  return { vcpus, memoryMiB, options };
}

/** Keyed by ComputeSDK adapter name. Only adapters that do not map sizes themselves are consulted. */
const VENDOR_SIZING: Readonly<Record<string, VendorSizing>> = {
  // Beam documents no larger size than 8 vCPU / 16 GiB.
  beam: {
    source: 'https://docs.beam.cloud/v2/sandbox/configuration',
    tiers: [
      tier(1, 1024, { cpu: 1, memory: 1024 }),
      tier(1, 2048, { cpu: 1, memory: 2048 }),
      tier(2, 4096, { cpu: 2, memory: 4096 }),
      tier(4, 8192, { cpu: 4, memory: 8192 }),
      tier(8, 16384, { cpu: 8, memory: 16384 }),
    ],
  },
  // Memory is in GiB. Daytona rejects resources for sandboxes created from a snapshot, which is its default.
  daytona: {
    source: 'https://www.daytona.io/docs/en/sandboxes/',
    requiredOption: 'image',
    excludedOptions: ['snapshotId', 'templateId'],
    tiers: [
      tier(1, 1024, { resources: { cpu: 1, memory: 1 } }),
      tier(1, 2048, { resources: { cpu: 1, memory: 2 } }),
      tier(2, 4096, { resources: { cpu: 2, memory: 4 } }),
      tier(4, 8192, { resources: { cpu: 4, memory: 8 } }),
    ],
  },
  // Modal counts physical cores, each worth two vCPUs. Without cpuLimit a sandbox may burst 16 cores above its request.
  modal: {
    source: 'https://modal.com/docs/guide/sandbox-resources',
    tiers: [
      tier(1, 1024, { cpu: 0.5, cpuLimit: 0.5, memoryMiB: 1024 }),
      tier(1, 2048, { cpu: 0.5, cpuLimit: 0.5, memoryMiB: 2048 }),
      tier(2, 4096, { cpu: 1, cpuLimit: 1, memoryMiB: 4096 }),
      tier(4, 8192, { cpu: 2, cpuLimit: 2, memoryMiB: 8192 }),
      tier(8, 16384, { cpu: 4, cpuLimit: 4, memoryMiB: 16384 }),
      tier(16, 32768, { cpu: 8, cpuLimit: 8, memoryMiB: 32768 }),
    ],
  },
  northflank: {
    source: 'https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas',
    tiers: [
      tier(1, 1024, { deploymentPlan: 'nf-compute-100-1' }),
      tier(1, 2048, { deploymentPlan: 'nf-compute-100-2' }),
      tier(2, 4096, { deploymentPlan: 'nf-compute-200' }),
      tier(4, 8192, { deploymentPlan: 'nf-compute-400' }),
      tier(8, 16384, { deploymentPlan: 'nf-compute-800-16' }),
      tier(16, 32768, { deploymentPlan: 'nf-compute-1600-32' }),
    ],
  },
  // A custom size needs at least 2 GiB per CPU, so 1 vCPU / 1 GiB has no exact Runloop size.
  runloop: {
    source: 'https://docs.runloop.ai/docs/devboxes/configuration/sizes',
    tiers: [
      tier(1, 2048, { launch_parameters: { resource_size_request: 'SMALL' } }),
      tier(2, 4096, { launch_parameters: { resource_size_request: 'MEDIUM' } }),
      tier(4, 8192, { launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: 4, custom_gb_memory: 8 } }),
      tier(8, 16384, { launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: 8, custom_gb_memory: 16 } }),
      tier(16, 32768, { launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: 16, custom_gb_memory: 32 } }),
    ],
  },
  // Each vCPU comes with 2 GiB. Pro allows up to 8 vCPUs; more needs Enterprise.
  vercel: {
    source: 'https://vercel.com/docs/sandbox/pricing',
    tiers: [
      tier(1, 2048, { resources: { vcpus: 1 } }),
      tier(2, 4096, { resources: { vcpus: 2 } }),
      tier(4, 8192, { resources: { vcpus: 4 } }),
      tier(8, 16384, { resources: { vcpus: 8 } }),
    ],
  },
};

/** Undefined when CostGraph has no mapping for the adapter. */
export function mapSize(
  adapter: string,
  size: InstanceSizeProfile,
  options: CreateInstanceOptions | undefined,
): SizeMapping | undefined {
  if (!Object.hasOwn(VENDOR_SIZING, adapter)) return undefined;
  const sizing = VENDOR_SIZING[adapter];
  const excluded = sizing.excludedOptions?.find((key) => options?.[key] !== undefined);
  if (excluded !== undefined) {
    return {
      status: 'unconfigured',
      reason: `${adapter} does not accept CPU and memory together with the "${excluded}" create option (${sizing.source})`,
    };
  }
  if (sizing.requiredOption !== undefined && options?.[sizing.requiredOption] === undefined) {
    return {
      status: 'unconfigured',
      reason: `${adapter} accepts CPU and memory only with the "${sizing.requiredOption}" create option (${sizing.source})`,
    };
  }
  const fit = sizing.tiers.find((candidate) => candidate.vcpus >= size.vcpus && candidate.memoryMiB >= size.memoryMiB);
  if (!fit) {
    const largest = sizing.tiers[sizing.tiers.length - 1];
    return {
      status: 'unsupported',
      reason:
        `${size.sizeClass} (${size.vcpus} vCPU, ${size.memoryMiB} MiB) is larger than the largest documented ` +
        `${adapter} size (${largest.vcpus} vCPU, ${largest.memoryMiB} MiB, ${sizing.source})`,
    };
  }
  return { status: 'supported', vcpus: fit.vcpus, memoryMiB: fit.memoryMiB, options: fit.options };
}

/** Replaces `sizeClass` with the vendor's own options; an option the caller set keeps the caller's value. */
export function applySizeOptions(options: CreateInstanceOptions, mapping: SupportedSizeMapping): CreateInstanceOptions {
  const { sizeClass: _sizeClass, ...applied } = options;
  for (const [key, value] of Object.entries(mapping.options)) {
    if (applied[key] === undefined) applied[key] = structuredClone(value);
  }
  return applied;
}

export function isExactSize(mapping: SupportedSizeMapping, size: InstanceSizeProfile): boolean {
  return mapping.vcpus === size.vcpus && mapping.memoryMiB === size.memoryMiB;
}
