/**
 * Transport for the Cline gateway and its public catalogs. Transport only: no
 * pinning, retry, or failover policy lives here (see `engine.ts` / `server.ts`).
 *
 * - `POST {baseURL}/chat/completions` — the gateway
 * - `GET  {baseURL}/models` — the gateway's own catalog
 * - `GET  {baseURL}/users/me/plan/usage-limits` — quota windows
 * - `GET  {baseURL}/users/me` — the account id daily usage needs
 * - `GET  {baseURL}/users/{id}/usages/daily` — per-day/per-model usage
 * - `GET  api.cline.bot/.../recommended-models` — official subscription list
 * - `GET  models.dev/api.json` — community registry, a backstop
 * - `GET  openrouter.ai/api/v1/...` — endpoint detail for direct models
 */
import type { DailyUsageRow, ModelCatalogEntry, UpstreamDetail, UsageLimit } from "./types.js"

/** The public Cline endpoint that lists subscription models without auth. */
export const RECOMMENDED_MODELS_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models"
/** The authenticated sub-path that reports quota consumption for the account. */
export const USAGE_LIMITS_PATH = "/users/me/plan/usage-limits"
/** The authenticated sub-path naming the account the usage history belongs to. */
export const PROFILE_PATH = "/users/me"
/** The authenticated sub-path carrying the account's plan and its quota caps. */
export const PLAN_PATH = "/users/me/plan"
/** How many usage rows one history page returns. */
export const USAGE_PAGE_SIZE = 200
/** How many history pages one row-level walk reads before it reports partial data. */
export const USAGE_MAX_PAGES = 12
/** One day in milliseconds. */
const DAY_MS = 86_400_000
/** How many models one window reports before the tail is summarised by count. */
export const MODEL_ROWS_MAX = 8
/** The community model registry. */
export const MODELS_DEV_URL = "https://models.dev/api.json"
/** OpenRouter's public API, used only for direct-pipeline endpoint detail. */
export const OPENROUTER_API = "https://openrouter.ai/api/v1"
/** Attribution header sent on every gateway request. */
export const USER_AGENT = "opencode-cline-pass/1.0.0"

/** Combine a caller signal with a timeout signal. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = []
  if (Number.isFinite(timeoutMs) && (timeoutMs as number) > 0) signals.push(AbortSignal.timeout(timeoutMs as number))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/** Strip a trailing slash so paths can be appended literally. */
export function trimBase(baseURL: string | undefined): string {
  return String(baseURL ?? "").trim().replace(/\/+$/, "")
}

/** The gateway's own chat-completions endpoint for one base URL. */
export function chatURL(baseURL: string): string {
  return `${trimBase(baseURL)}/chat/completions`
}

export interface JSONResponse {
  status: number
  ok: boolean
  json: any
  text: string
}

export interface SendOptions {
  method?: "GET" | "POST"
  apiKey?: string
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

/** Send one JSON request and decode whatever comes back. */
export async function sendJSON(url: string, options: SendOptions = {}): Promise<JSONResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const apiKey = options.apiKey ?? ""
  const outgoing: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      "user-agent": USER_AGENT,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(apiKey === "" ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 60000),
  }
  const response = await fetchImpl(url, outgoing)
  const text = await response.text()
  let json: any = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

export interface ChatOptions {
  baseURL: string
  apiKey: string
  body: unknown
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Send one chat completion, non-streaming. */
export function chatCompletion(options: ChatOptions): Promise<JSONResponse> {
  return sendJSON(chatURL(options.baseURL), {
    method: "POST",
    apiKey: options.apiKey,
    body: options.body,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 180000,
    fetchImpl: options.fetchImpl,
  })
}

/** Open a streaming chat completion and hand back the live response. */
export async function openChatStream(options: ChatOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  return await fetchImpl(chatURL(options.baseURL), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "user-agent": USER_AGENT,
      ...(options.apiKey === "" ? {} : { Authorization: `Bearer ${options.apiKey}` }),
    },
    body: JSON.stringify(options.body),
    signal: options.signal,
  })
}

/**
 * Read the metadata one catalog source publishes about a model.
 *
 * models.dev nests readable modalities under `modalities.input` and caps under
 * `limit`. Fields a source omits stay absent rather than becoming a guess.
 */
function modelMetadata(entry: any): Partial<ModelCatalogEntry> {
  const meta: Partial<ModelCatalogEntry> = {}
  const name = entry?.name
  if (typeof name === "string" && name.trim().length > 0) meta.name = name.trim()
  const modalities = entry?.modalities?.input ?? entry?.input
  if (Array.isArray(modalities)) {
    const input = modalities.filter((value: unknown) => typeof value === "string" && value.length > 0)
    if (input.length > 0) meta.input = input
  }
  const contextWindow = entry?.limit?.context ?? entry?.contextWindow
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) meta.contextWindow = contextWindow
  const maxTokens = entry?.limit?.output ?? entry?.maxTokens
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) meta.maxTokens = maxTokens
  if (typeof entry?.reasoning === "boolean") meta.reasoning = entry.reasoning
  return meta
}

/** List the gateway's own catalog ids. */
export async function fetchGatewayCatalog(options: {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<string[]> {
  try {
    const result = await sendJSON(`${trimBase(options.baseURL)}/models`, {
      apiKey: options.apiKey,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30000,
      fetchImpl: options.fetchImpl,
    })
    return (result.json?.data ?? [])
      .map((model: any) => model?.id)
      .filter((id: unknown): id is string => typeof id === "string")
  } catch {
    return []
  }
}

/** The gateway's own one-line explanation, when it sent one. */
function firstMessage(envelope: any): string {
  const message = envelope?.error ?? envelope?.message ?? envelope?.error?.message
  return typeof message === "string" ? message.slice(0, 200) : ""
}

export interface Reading<T> {
  ok: boolean
  error: string
  value?: T
}

/**
 * Read the account's official quota consumption.
 *
 * The gateway answers with `{ success, data: { limits: [{ type, percentUsed,
 * resetsAt }] } }`. The window list is passed through in the order the gateway
 * sends it, so a window Cline adds later reaches the dashboard as an extra row.
 * A refusal is reported as data, never thrown.
 */
export async function fetchUsageLimits(options: {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ ok: boolean; limits: UsageLimit[]; error: string }> {
  const refusal = { ok: false, limits: [] as UsageLimit[], error: "the usage endpoint is unavailable" }
  try {
    const result = await sendJSON(`${trimBase(options.baseURL)}${USAGE_LIMITS_PATH}`, {
      apiKey: options.apiKey,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30000,
      fetchImpl: options.fetchImpl,
    })
    if (!result.ok) {
      const detail = firstMessage(result.json) ?? result.text.slice(0, 120)
      return {
        ...refusal,
        error: `the usage endpoint answered HTTP ${result.status}${detail === "" ? "" : `: ${detail}`}`,
      }
    }
    const payload = result.json?.data ?? result.json
    const limits = (Array.isArray(payload?.limits) ? payload.limits : [])
      .map((limit: any) => ({
        type: String(limit?.type ?? ""),
        percentUsed: Number(limit?.percentUsed ?? 0),
        resetsAt: String(limit?.resetsAt ?? ""),
      }))
      .filter((limit: UsageLimit) => limit.type.length > 0)
    return { ok: true, limits, error: firstMessage(result.json) ?? "" }
  } catch (error) {
    return { ...refusal, error: String((error as Error)?.message ?? error) }
  }
}

/** The account id behind one key, which the daily usage endpoint needs. */
export async function fetchProfile(options: {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ ok: boolean; id: string; error: string }> {
  try {
    const result = await sendJSON(`${trimBase(options.baseURL)}${PROFILE_PATH}`, {
      apiKey: options.apiKey,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30000,
      fetchImpl: options.fetchImpl,
    })
    const payload = result.json?.data ?? result.json
    const id = String(payload?.id ?? payload?.user?.id ?? payload?.userId ?? "")
    if (!result.ok) {
      return { ok: false, id: "", error: `the profile endpoint answered HTTP ${result.status}` }
    }
    return { ok: id.length > 0, id, error: id.length > 0 ? "" : "the profile endpoint returned no account id" }
  } catch (error) {
    return { ok: false, id: "", error: String((error as Error)?.message ?? error) }
  }
}

/** A `YYYY-MM-DD` day, in UTC, as the daily endpoint expects it. */
function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * One range of per-day usage, from the gateway's own aggregation.
 *
 * Rows are per day AND per model, so they sum along either axis. The model is
 * kept rather than flattened away: which models a window's spend went to is the
 * question a quota figure cannot answer.
 */
export async function fetchDailyUsage(options: {
  baseURL: string
  apiKey: string
  userId: string
  startDate?: string
  endDate?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ ok: boolean; rows: DailyUsageRow[]; error: string }> {
  const now = Date.now()
  const startDate = options.startDate ?? dayStamp(now - 30 * DAY_MS)
  const endDate = options.endDate ?? dayStamp(now)
  const refusal = { ok: false, rows: [] as DailyUsageRow[], error: "the daily usage endpoint is unavailable" }
  try {
    const query = `${trimBase(options.baseURL)}/users/${encodeURIComponent(
      options.userId,
    )}/usages/daily?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    const result = await sendJSON(query, {
      apiKey: options.apiKey,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 45000,
      fetchImpl: options.fetchImpl,
    })
    if (!result.ok) {
      const detail = firstMessage(result.json)
      return {
        ...refusal,
        error: `the daily usage endpoint answered HTTP ${result.status}${detail === "" ? "" : `: ${detail}`}`,
      }
    }
    const payload = result.json?.data ?? result.json
    const rows = (Array.isArray(payload?.items) ? payload.items : []).map((row: any) => ({
      date: String(row?.date ?? ""),
      model: String(row?.aiModelName ?? row?.aiModelTypeName ?? ""),
      tokens: Number(row?.promptTokens ?? 0) + Number(row?.completionTokens ?? 0),
      // Cline's field is named `costUsd` but carries micro-USD (1e-6 USD).
      // Convert at the transport boundary so every consumer sees dollars.
      costUsd: Number(row?.costUsd ?? 0) / 1_000_000,
    }))
    return { ok: true, rows, error: "" }
  } catch (error) {
    return { ...refusal, error: String((error as Error)?.message ?? error) }
  }
}

export interface OfficialScan {
  models: string[]
  catalog: Record<string, Partial<ModelCatalogEntry>>
  sources: string[]
}

type FoundEntry = Partial<ModelCatalogEntry>

/**
 * Collect `cline-pass/*` ids from the official endpoints and the community
 * registry. Additive by design: every source that answers contributes, and a
 * source that fails is skipped rather than failing the scan.
 */
export async function fetchOfficialModels(options: {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
} = {}): Promise<OfficialScan> {
  const fetchImpl = options.fetchImpl ?? fetch
  const found = new Map<string, FoundEntry>()
  const sources: string[] = []
  const add = (value: unknown): void => {
    const id = typeof value === "string" ? value : (value as { id?: unknown } | null)?.id
    if (typeof id !== "string") return
    const normalized = id.trim().toLowerCase()
    if (!normalized.startsWith("cline-pass/")) return
    const incoming: FoundEntry = typeof value === "string" ? {} : modelMetadata(value)
    const existing = found.get(normalized)
    found.set(normalized, existing === undefined ? incoming : { ...incoming, ...existing })
  }
  try {
    const response = await fetchImpl(RECOMMENDED_MODELS_URL, { signal: withTimeout(options.signal, options.timeoutMs ?? 30000) })
    if (response.ok) {
      const json: any = await response.json()
      const list = json?.clinePass ?? json?.data?.clinePass
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(add)
        sources.push("cline.api")
      }
    }
  } catch {
    /* source unavailable */
  }
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: withTimeout(options.signal, options.timeoutMs ?? 30000) })
    if (response.ok) {
      const json: any = await response.json()
      const provider = json?.providers?.["cline-pass"] ?? json?.["cline-pass"]
      if (provider?.models !== undefined && provider.models !== null) {
        for (const [id, entry] of Object.entries(provider.models)) {
          add({ ...(entry ?? {}), id: id.startsWith("cline-pass/") ? id : `cline-pass/${id}` })
        }
        sources.push("models.dev")
      }
    }
  } catch {
    /* source unavailable */
  }
  const models = [...found.keys()].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id))
  const catalog: Record<string, Partial<ModelCatalogEntry>> = {}
  for (const id of models) {
    const meta = found.get(id)
    if (meta !== undefined && Object.keys(meta).length > 0) catalog[id] = meta
  }
  return { models, catalog, sources }
}

/** Resolve a canonical slug against OpenRouter's public catalog, tolerating hyphen differences. */
export async function resolveOpenRouterSlug(
  slug: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  try {
    const result = await sendJSON(`${OPENROUTER_API}/models`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30000,
      fetchImpl: options.fetchImpl,
    })
    const ids: string[] = (result.json?.data ?? [])
      .map((model: any) => model?.id)
      .filter((id: unknown): id is string => typeof id === "string")
    const normalize = (value: string) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "")
    return ids.find((id) => id === slug) ?? ids.find((id) => normalize(id) === normalize(slug)) ?? null
  } catch {
    return null
  }
}

/**
 * Per-upstream endpoint detail (context length, recent uptime) for one
 * OpenRouter model. Only meaningful for direct-pipeline models.
 */
export async function openRouterEndpoints(
  slug: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ slug: string; endpoints: UpstreamDetail[] }> {
  const real = await resolveOpenRouterSlug(slug, options)
  if (real === null) return { slug, endpoints: [] }
  try {
    const result = await sendJSON(`${OPENROUTER_API}/models/${real}/endpoints`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30000,
      fetchImpl: options.fetchImpl,
    })
    const detail = new Map<string, UpstreamDetail>()
    for (const entry of result.json?.data?.endpoints ?? []) {
      const providerSlug =
        String(entry?.tag ?? "").split("/")[0] ||
        String(entry?.provider_name ?? "")
          .toLowerCase()
          .replace(/\s+/g, "-")
      if (providerSlug === "") continue
      const current = detail.get(providerSlug) ?? {
        slug: providerSlug,
        name: String(entry?.provider_name ?? providerSlug),
        endpoints: 0,
        context: 0,
        uptime: 0,
      }
      current.endpoints += 1
      current.context = Math.max(current.context, Number(entry?.context_length ?? 0))
      current.uptime = Math.max(current.uptime, Math.round(Number(entry?.uptime_last_30m ?? 0)))
      detail.set(providerSlug, current)
    }
    return { slug: real, endpoints: [...detail.values()] }
  } catch {
    return { slug: real, endpoints: [] }
  }
}
