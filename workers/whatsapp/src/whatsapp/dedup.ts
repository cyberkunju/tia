/**
 * Two-layer inbound deduplication with idempotency.
 *
 * Meta delivers webhooks at-least-once and retries for up to ~7 days, so one inbound timesheet can
 * arrive many times. We must process each Message_Id at most once - never creating a duplicate
 * intake - and survive restarts. Two layers:
 *
 *  1. A bounded in-memory ring (fast first-line cache for the "seen it moments ago" case).
 *  2. An injectable durable port (in-memory for this transport bridge; the core's `events` table
 *     is the durable cross-restart idempotency layer, reached via the forwarded Idempotency-Key).
 *
 * Semantics:
 *  - `claim` is a single atomic conditional reservation: of any number of concurrent attempts for
 *    one fresh id, exactly one returns "claimed".
 *  - An in-progress reservation older than IN_PROGRESS_TTL_MS is re-claimable, so a crash between
 *    reserve and complete never wedges a message forever.
 *  - Processed rows are retained ≥ RETENTION_MS to cover Meta's retry window; pruning removes only
 *    older rows.
 *  - If the durable layer throws or exceeds DURABLE_TIMEOUT_MS, the store FAILS OPEN (returns
 *    "claimed") so a timesheet is processed rather than silently dropped.
 */

export const RING_CAPACITY = 2000;
export const IN_PROGRESS_TTL_MS = 60_000;
export const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const DURABLE_TIMEOUT_MS = 2_000;

export type ClaimResult = "claimed" | "duplicate";

/** Durable persistence port. Production = Postgres; tests = in-memory fake (same contract). */
export interface DurableDedupStore {
  claim(id: string, nowMs: number, inProgressTtlMs: number): Promise<ClaimResult>;
  markProcessed(id: string, nowMs: number): Promise<void>;
  release(id: string): Promise<void>;
  prune(nowMs: number, retentionMs: number): Promise<number>;
}

export interface DedupStoreOptions {
  readonly durable: DurableDedupStore;
  readonly now?: () => number;
  readonly ringCapacity?: number;
  readonly inProgressTtlMs?: number;
  readonly retentionMs?: number;
  readonly durableTimeoutMs?: number;
  readonly pruneEveryNProcessed?: number;
}

export interface DedupStore {
  seenInMemory(id?: string): boolean;
  claimDurable(id: string): Promise<ClaimResult>;
  claim(id?: string): Promise<ClaimResult>;
  markProcessed(id: string): Promise<void>;
  releaseClaim(id: string): Promise<void>;
  prune(): Promise<number>;
}

const TIMED_OUT = Symbol("dedup-durable-timeout");

async function raceTimeout<T>(op: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createDedupStore(options: DedupStoreOptions): DedupStore {
  const durable = options.durable;
  const now = options.now ?? Date.now;
  const ringCapacity = options.ringCapacity ?? RING_CAPACITY;
  const inProgressTtlMs = options.inProgressTtlMs ?? IN_PROGRESS_TTL_MS;
  const retentionMs = options.retentionMs ?? RETENTION_MS;
  const durableTimeoutMs = options.durableTimeoutMs ?? DURABLE_TIMEOUT_MS;
  const pruneEveryN = options.pruneEveryNProcessed ?? 50;

  const ring = new Set<string>();
  const order: string[] = [];
  let processedSincePrune = 0;

  function remember(id: string): void {
    if (ring.has(id)) return;
    ring.add(id);
    order.push(id);
    while (order.length > ringCapacity) {
      const evicted = order.shift();
      if (evicted !== undefined) ring.delete(evicted);
    }
  }

  function seenInMemory(id?: string): boolean {
    if (id === undefined || id.length === 0) return false;
    return ring.has(id);
  }

  async function claimDurable(id: string): Promise<ClaimResult> {
    try {
      const result = await raceTimeout(durable.claim(id, now(), inProgressTtlMs), durableTimeoutMs);
      if (result === TIMED_OUT) return "claimed"; // fail open
      return result;
    } catch {
      return "claimed"; // fail open
    }
  }

  async function claim(id?: string): Promise<ClaimResult> {
    if (id === undefined || id.length === 0) return "claimed";
    if (seenInMemory(id)) return "duplicate";
    return claimDurable(id);
  }

  async function markProcessed(id: string): Promise<void> {
    remember(id);
    await durable.markProcessed(id, now());
    processedSincePrune += 1;
    if (processedSincePrune >= pruneEveryN) {
      processedSincePrune = 0;
      try {
        await durable.prune(now(), retentionMs);
      } catch {
        /* best-effort */
      }
    }
  }

  async function releaseClaim(id: string): Promise<void> {
    ring.delete(id);
    const idx = order.indexOf(id);
    if (idx !== -1) order.splice(idx, 1);
    await durable.release(id);
  }

  async function prune(): Promise<number> {
    return durable.prune(now(), retentionMs);
  }

  return { seenInMemory, claimDurable, claim, markProcessed, releaseClaim, prune };
}

// ── In-memory fake (tests + MEMORY mode) ───────────────────────────────────
interface FakeRow {
  status: "in_progress" | "processed";
  statusAt: number;
}

export interface FakeDurableDedupStore extends DurableDedupStore {
  peek(id: string): { status: "in_progress" | "processed"; statusAt: number } | undefined;
  size(): number;
  seed(id: string, status: "in_progress" | "processed", statusAt: number): void;
}

export function createFakeDurableDedupStore(): FakeDurableDedupStore {
  const rows = new Map<string, FakeRow>();
  return {
    async claim(id, nowMs, inProgressTtlMs) {
      const row = rows.get(id);
      if (row === undefined) {
        rows.set(id, { status: "in_progress", statusAt: nowMs });
        return "claimed";
      }
      if (row.status === "processed") return "duplicate";
      if (nowMs - row.statusAt >= inProgressTtlMs) {
        row.status = "in_progress";
        row.statusAt = nowMs;
        return "claimed";
      }
      return "duplicate";
    },
    async markProcessed(id, nowMs) {
      rows.set(id, { status: "processed", statusAt: nowMs });
    },
    async release(id) {
      const row = rows.get(id);
      if (row !== undefined && row.status === "in_progress") rows.delete(id);
    },
    async prune(nowMs, retentionMs) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.status === "processed" && nowMs - row.statusAt >= retentionMs) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    peek(id) {
      const row = rows.get(id);
      return row === undefined ? undefined : { status: row.status, statusAt: row.statusAt };
    },
    size() {
      return rows.size;
    },
    seed(id, status, statusAt) {
      rows.set(id, { status, statusAt });
    },
  };
}

