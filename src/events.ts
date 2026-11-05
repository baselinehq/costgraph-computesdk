import type { InstanceSizeClass } from 'computesdk';
import { CostGraphApiError, discardBody, errorMessage, unrefTimer, type CostGraphApi } from './api.js';

const EVENTS_PATH = '/api/v1/tenant/sandboxes/events';
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_QUEUED_EVENTS = 10_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

const MAX_METADATA_KEYS = 20;
const MAX_METADATA_KEY_BYTES = 64;
const MAX_METADATA_VALUE_BYTES = 256;

export interface StartedEvent {
  readonly type: 'started';
  readonly provider: string;
  readonly sandbox_id: string;
  readonly at: string;
  readonly decision_id?: string;
  readonly size_class?: InstanceSizeClass;
  readonly vcpus?: number;
  readonly memory_mib?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export type StartedSize = Pick<StartedEvent, 'size_class' | 'vcpus' | 'memory_mib'>;

export interface StoppedEvent {
  readonly type: 'stopped';
  readonly provider: string;
  readonly sandbox_id: string;
  readonly at: string;
}

export type SandboxEvent = StartedEvent | StoppedEvent;

export class EventReporter {
  private queue: SandboxEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  /** Events at the front of the queue that the current drain sends even as a partial batch. */
  private partialCutoff = 0;
  private apiUnavailable = false;
  private overflowing = false;

  constructor(
    private readonly api: CostGraphApi,
    private readonly reportError: (error: unknown) => void,
  ) {}

  push(event: SandboxEvent): void {
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUED_EVENTS) {
      const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUED_EVENTS).length;
      this.partialCutoff = Math.max(0, this.partialCutoff - dropped);
      if (!this.overflowing) {
        this.overflowing = true;
        this.reportError(new Error('CostGraph sandbox event queue is full: dropping the oldest events'));
      }
    }
    if (this.queue.length >= BATCH_SIZE) {
      void this.drain(false);
    } else {
      this.schedule();
    }
  }

  /**
   * Sends the events queued when it is called. Resolves within `timeoutMs` and never rejects.
   * Holds a timer so Node stays alive while it waits, even though background sends do not.
   */
  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([this.drain(true), expired]);
    } finally {
      clearTimeout(deadline);
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.draining) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain(true);
    }, FLUSH_INTERVAL_MS);
    unrefTimer(this.timer);
  }

  /** A full-batch drain sends only full batches; the timer and flush() also send what is queued now. */
  private drain(includePartial: boolean): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (includePartial) this.partialCutoff = this.queue.length;
    if (this.draining) return this.draining;
    if (!this.hasBatchToSend()) return Promise.resolve();
    this.draining = this.sendQueued();
    return this.draining;
  }

  private hasBatchToSend(): boolean {
    return this.partialCutoff > 0 || this.queue.length >= BATCH_SIZE;
  }

  private async sendQueued(): Promise<void> {
    try {
      while (this.hasBatchToSend()) {
        const batch = this.queue.splice(0, BATCH_SIZE);
        this.partialCutoff = Math.max(0, this.partialCutoff - batch.length);
        await this.send(batch);
      }
    } finally {
      // Runs in the same tick as the final loop check, so a flush() that joined this drain is never left behind.
      this.draining = undefined;
      this.apiUnavailable = false;
      if (this.queue.length > 0) this.schedule();
    }
  }

  /** After one batch exhausts its retries, the rest of the drain gets a single attempt each. */
  private async send(events: SandboxEvent[]): Promise<void> {
    const maxAttempts = this.apiUnavailable ? 1 : MAX_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.api.post(EVENTS_PATH, { events }, REQUEST_TIMEOUT_MS, discardBody);
        this.overflowing = false;
        return;
      } catch (error) {
        const retryable = error instanceof CostGraphApiError && error.retryable;
        if (!retryable || attempt >= maxAttempts) {
          if (retryable) this.apiUnavailable = true;
          this.reportError(new Error(`Dropped ${events.length} CostGraph sandbox event(s): ${errorMessage(error)}`, { cause: error }));
          return;
        }
        await backoff(attempt);
      }
    }
  }
}

function backoff(attempt: number): Promise<void> {
  const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
  return new Promise((resolve) => unrefTimer(setTimeout(resolve, delay)));
}

/** Keeps only string values within the API limits so one bad tag never fails a batch. */
export function sanitizeMetadata(metadata: unknown): Record<string, string> | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (entries.length >= MAX_METADATA_KEYS) break;
    if (typeof value !== 'string' || key.length === 0 || utf8Length(key) > MAX_METADATA_KEY_BYTES) continue;
    entries.push([key, truncateUtf8(value, MAX_METADATA_VALUE_BYTES)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** Limits are enforced in UTF-8 bytes, which also bounds characters, and cuts only between code points. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let bytes = 0;
  let truncated = '';
  for (const char of value) {
    bytes += utf8Length(char);
    if (bytes > maxBytes) break;
    truncated += char;
  }
  return truncated;
}
