import {
  hasInstanceSizeRequest,
  validateInstanceSizeOptions,
  type CommandResult,
  type CreateInstanceOptions,
  type InstanceInfo,
  type InstanceInterface,
  type RunCommandOptions,
} from 'computesdk';
import { CostGraphApi, CostGraphApiError, discardBody, isRecord, readData, type FetchFunction } from './api.js';
import { sanitizeMetadata } from './events.js';
import { DEFAULT_BASE_URL, PROVIDER_NAME, type DirectProvider } from './provider.js';

const SANDBOXES_PATH = '/api/v1/tenant/sandboxes';
const REQUEST_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 300_000;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const BASE64_CHUNK = 0x8000;

type InstanceManager = Required<NonNullable<DirectProvider['instances']>>;

export type SandboxPolicy = 'cheapest' | 'balanced' | 'fastest';

export interface CostGraphConnectionsOptions {
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
  tenantId?: string;
  policy?: SandboxPolicy;
  provider?: string;
  fetch?: FetchFunction;
}

export interface CostGraphConnectionsProvider {
  readonly name: typeof PROVIDER_NAME;
  readonly instances: InstanceManager;
}

export type CommandOutput = CommandResult & { readonly truncated: boolean };

interface SandboxRef {
  readonly provider: string;
  readonly sandboxId: string;
}

export function costgraphConnections(options: CostGraphConnectionsOptions): CostGraphConnectionsProvider {
  if (!options.apiKey && !options.accessToken) {
    throw new TypeError('costgraphConnections() needs an apiKey or an accessToken');
  }
  return new ConnectionsProvider(options);
}

class ConnectionsProvider implements CostGraphConnectionsProvider {
  readonly name = PROVIDER_NAME;
  readonly instances: InstanceManager;

  private readonly api: CostGraphApi;
  private readonly providers = new Map<string, string>();

  constructor(private readonly options: CostGraphConnectionsOptions) {
    this.api = new CostGraphApi({
      apiKey: options.apiKey,
      accessToken: options.accessToken,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      tenantId: options.tenantId,
      fetch: options.fetch,
    });
    this.instances = {
      create: (createOptions) => this.create(createOptions),
      getById: (sandboxId) => this.getById(sandboxId),
      list: () => this.list(),
      destroy: (sandboxId) => this.destroy(sandboxId),
    };
  }

  private async create(options: CreateInstanceOptions = {}): Promise<InstanceInterface> {
    if (hasInstanceSizeRequest(options)) validateInstanceSizeOptions(options);
    const metadata = sanitizeMetadata(options.metadata);
    const data = await this.api.post(
      SANDBOXES_PATH,
      {
        policy: this.options.policy,
        provider: typeof options.provider === 'string' ? options.provider : this.options.provider,
        size_class: options.sizeClass,
        metadata,
        lifecycle: options.timeout === undefined ? undefined : { timeout_ms: options.timeout },
      },
      CREATE_TIMEOUT_MS,
      readRecord,
    );
    return this.adopt(sandboxRefOf(data));
  }

  private async getById(sandboxId: string): Promise<InstanceInterface | null> {
    const provider = await this.providerOf(sandboxId);
    if (provider === undefined) return null;
    const ref = { provider, sandboxId };
    try {
      await this.api.get(sandboxPath(ref), REQUEST_TIMEOUT_MS, readRecord);
    } catch (error) {
      if (isNotFound(error)) {
        this.forget(sandboxId);
        return null;
      }
      throw error;
    }
    return this.instance(ref);
  }

  private async list(): Promise<InstanceInterface[]> {
    const data = await this.api.get(SANDBOXES_PATH, REQUEST_TIMEOUT_MS, readData);
    if (!Array.isArray(data)) throw new CostGraphApiError('sandbox list response is not a list');
    return data.map((row: unknown) => this.adopt(sandboxRefOf(asRecord(row))));
  }

  private async destroy(sandboxId: string): Promise<void> {
    const provider = await this.providerOf(sandboxId);
    if (provider === undefined) throw new Error(`Sandbox "${sandboxId}" was not found`);
    try {
      await this.api.delete(sandboxPath({ provider, sandboxId }), REQUEST_TIMEOUT_MS, discardBody);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.forget(sandboxId);
  }

  private async providerOf(sandboxId: string): Promise<string | undefined> {
    if (!this.providers.has(sandboxId)) await this.list();
    return this.providers.get(sandboxId);
  }

  private adopt(ref: SandboxRef): InstanceInterface {
    this.providers.set(ref.sandboxId, ref.provider);
    return this.instance(ref);
  }

  private forget(sandboxId: string): void {
    this.providers.delete(sandboxId);
  }

  private instance(ref: SandboxRef): InstanceInterface {
    const path = sandboxPath(ref);
    const filesPath = (file: string) => `${path}/files?path=${encodeURIComponent(file)}`;
    return {
      instanceId: ref.sandboxId,
      sandboxId: ref.sandboxId,
      provider: ref.provider,
      runCommand: (command, options) => this.runCommand(path, command, options),
      startProcess: () => unsupported('startProcess'),
      getUrl: () => unsupported('getUrl'),
      getInfo: async (): Promise<InstanceInfo> => {
        const data = await this.api.get(path, REQUEST_TIMEOUT_MS, readRecord);
        return {
          id: ref.sandboxId,
          provider: ref.provider,
          status: data.running === false ? 'stopped' : 'running',
          createdAt: new Date(typeof data.started_at === 'string' ? data.started_at : Number.NaN),
          timeout: 0,
          metadata: data,
        };
      },
      destroy: () => this.destroy(ref.sandboxId),
      filesystem: {
        readFile: async (file) => {
          const data = await this.api.get(filesPath(file), REQUEST_TIMEOUT_MS, readRecord);
          if (typeof data.content_base64 !== 'string') throw new CostGraphApiError('file response has no content');
          return fromBase64(data.content_base64);
        },
        writeFile: async (file, content) => {
          await this.api.put(filesPath(file), { content_base64: toBase64(content) }, REQUEST_TIMEOUT_MS, discardBody);
        },
        readdir: () => unsupported('filesystem.readdir'),
        mkdir: () => unsupported('filesystem.mkdir'),
        exists: () => unsupported('filesystem.exists'),
        remove: () => unsupported('filesystem.remove'),
      },
    };
  }

  private async runCommand(path: string, command: string, options: RunCommandOptions = {}): Promise<CommandOutput> {
    const started = Date.now();
    const waitMs = options.background ? REQUEST_TIMEOUT_MS : (options.timeout ?? DEFAULT_EXEC_TIMEOUT_MS) + REQUEST_TIMEOUT_MS;
    const data = await this.api.post(
      `${path}/exec`,
      { command, cwd: options.cwd, env: options.env, timeout_ms: options.timeout, background: options.background },
      waitMs,
      readRecord,
    );
    const stdout = typeof data.stdout === 'string' ? data.stdout : '';
    const stderr = typeof data.stderr === 'string' ? data.stderr : '';
    if (stdout) options.onStdout?.(stdout);
    if (stderr) options.onStderr?.(stderr);
    return {
      stdout,
      stderr,
      exitCode: typeof data.exit_code === 'number' ? data.exit_code : 0,
      durationMs: Date.now() - started,
      truncated: data.truncated === true,
    };
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof CostGraphApiError && error.status === 404;
}

function sandboxPath(ref: SandboxRef): string {
  return `${SANDBOXES_PATH}/${encodeURIComponent(ref.provider)}/${encodeURIComponent(ref.sandboxId)}`;
}

function sandboxRefOf(data: Record<string, unknown>): SandboxRef {
  const { provider, sandbox_id: sandboxId } = data;
  if (typeof provider !== 'string' || typeof sandboxId !== 'string') {
    throw new CostGraphApiError('sandbox response names no provider and sandbox_id');
  }
  return { provider, sandboxId };
}

async function readRecord(response: Response): Promise<Record<string, unknown>> {
  return asRecord(await readData(response));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CostGraphApiError('response data is not an object');
  return value;
}

function unsupported(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is not available on sandboxes run through CostGraph connections`));
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
}
