/**
 * Runtime observation state: pipeline detection, discovered upstream channels,
 * per-channel verdicts, request history, and cached quota readings.
 *
 * This is derived data any probe can rebuild, so it is never persisted.
 */
import { MAX_UPSTREAMS } from "./protocol.js"
import type { HistoryEntry, ModelMeta, UpstreamVerdict, UsageReading } from "./types.js"

/** How many request-history rows are retained by default. */
export const DEFAULT_HISTORY_LIMIT = 100

/** One upstream availability verdict. */
function verdict(status: string, note: unknown, ms: unknown): UpstreamVerdict {
  return {
    status,
    note: String(note ?? "").slice(0, 200),
    ms: Number(ms ?? 0),
    checkedAt: Date.now(),
  }
}

export interface CatalogCache {
  ids: string[]
  models: Record<string, Record<string, unknown>>
  sources: string[]
  fetchedAt: number
}

export interface UsageCache {
  ok: boolean
  accounts: UsageReading[]
  fetchedAt: number
}

/** The observation store. */
export class ObservationStore {
  private readonly models = new Map<string, ModelMeta>()
  private history: HistoryEntry[] = []
  private revision = 0
  private catalogCache: CatalogCache = { ids: [], models: {}, sources: [], fetchedAt: 0 }
  private usageCache: UsageCache = { ok: false, accounts: [], fetchedAt: 0 }
  private limit: number

  constructor(options: { historyLimit?: number } = {}) {
    this.limit = Math.max(1, Math.floor(options.historyLimit ?? DEFAULT_HISTORY_LIMIT))
  }

  /** Discovered metadata for one model (never undefined). */
  metaOf(model: string): ModelMeta {
    return this.models.get(model) ?? {}
  }

  /** Every model with discovered metadata. */
  allMeta(): Array<ModelMeta & { id: string }> {
    return [...this.models.entries()].map(([id, meta]) => ({ id, ...meta }))
  }

  /** Merge one discovery result into a model's metadata. */
  learn(model: string, patch: Partial<ModelMeta>): ModelMeta {
    const current = this.models.get(model) ?? {}
    const next: ModelMeta = { ...current, ...patch }
    if (patch?.upstreamStatus !== undefined) {
      next.upstreamStatus = { ...(current.upstreamStatus ?? {}), ...patch.upstreamStatus }
    }
    if (next.upstreams !== undefined) {
      next.upstreams = [...new Set(next.upstreams.map(String).filter((name) => name.length > 0))].slice(
        0,
        MAX_UPSTREAMS,
      )
    }
    this.models.set(model, next)
    return next
  }

  /** Record a verdict; explicit validation also replaces stale results with unknown. */
  learnUpstream(
    model: string,
    upstream: string | null | undefined,
    status: string,
    note: unknown,
    ms: unknown,
    options: { includeUnknown?: boolean } = {},
  ): void {
    if (upstream === undefined || upstream === null || upstream === "") return
    if (status === "unknown" && options.includeUnknown !== true) return
    const current = this.models.get(model) ?? {}
    this.models.set(model, {
      ...current,
      upstreamStatus: { ...(current.upstreamStatus ?? {}), [upstream]: verdict(status, note, ms) },
    })
  }

  /** Append one request-history row (newest first, bounded). */
  record(entry: Omit<HistoryEntry, "ts"> & { ts?: number }): void {
    this.revision += 1
    this.history.unshift({ ts: entry.ts ?? Date.now(), ...entry })
    if (this.history.length > this.limit) this.history.length = this.limit
  }

  /** Read request history, newest first. */
  readHistory(limit = this.limit, model = ""): HistoryEntry[] {
    const needle = String(model ?? "").trim().toLowerCase()
    return this.history
      .filter((entry) => needle === "" || String(entry.model ?? "").toLowerCase().includes(needle))
      .slice(0, Math.max(0, Math.min(limit, this.limit)))
  }

  /** Total rows retained, before any filter. */
  historySize(): number {
    return this.history.length
  }

  /** Monotonic change counter, including replacements at the retention cap. */
  historyRevision(): number {
    return this.revision
  }

  /** Change the retention cap, trimming immediately when it shrinks. */
  setHistoryLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit))
    if (this.history.length > this.limit) this.history.length = this.limit
  }

  /** The last cached official-catalog scan. */
  catalog(): CatalogCache {
    return this.catalogCache
  }

  /** Replace the cached official-catalog scan. */
  setCatalog(next: Omit<CatalogCache, "fetchedAt"> & { fetchedAt?: number }): CatalogCache {
    this.catalogCache = { ...next, fetchedAt: next.fetchedAt ?? Date.now() }
    return this.catalogCache
  }

  /** The last quota reading (never undefined). */
  usage(): UsageCache {
    return this.usageCache
  }

  /** Replace the cached quota reading. */
  setUsage(next: Partial<UsageCache>): UsageCache {
    this.usageCache = { ...this.usageCache, ...next, fetchedAt: Date.now() }
    return this.usageCache
  }
}

/** Create the observation store. */
export function createStore(options: { historyLimit?: number } = {}): ObservationStore {
  return new ObservationStore(options)
}
