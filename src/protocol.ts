/**
 * Cline Pass wire protocol: pipeline detection, pin injection, failover
 * expansion, and error classification. Every function here is pure.
 *
 * The two pipelines spell a pin differently:
 * - `direct` (OpenRouter): top-level `provider.only/order/sort/ignore`.
 * - `planner` (Vercel AI Gateway): only `providerOptions.gateway.*` survives.
 */
import type { Adherence, Attempt, ModelMeta, PinConfig, Routing } from "./types.js"

/** Identity of this build, surfaced by status and the startup log. */
export const BUILD_TAG = "opencode-1"

/** How many channels one model's list may hold. */
export const MAX_UPSTREAMS = 64

/** OpenRouter's names for the three sort metrics. */
export const OPENROUTER_SORT: Record<string, string> = {
  cost: "price",
  ttft: "latency",
  tps: "throughput",
}

/**
 * Channels the two routers spell differently, as `[planner, direct]` pairs.
 *
 * Writing one name into both spellings is not cosmetic: OpenRouter refuses an
 * unknown provider in `provider.only`, so the wrong spelling of a real channel
 * can fail a request the right spelling would have served.
 */
export const CHANNEL_ALIASES: Array<[string, string]> = [["zai", "z-ai"]]

/** The gateway wraps some answers in a `{ data: … }` envelope; unwrap it. */
export function unwrapEnvelope<T = any>(json: unknown): T {
  if (
    json !== null &&
    typeof json === "object" &&
    (json as any).data !== null &&
    typeof (json as any).data === "object" &&
    (json as any).data.choices !== undefined
  ) {
    return (json as any).data as T
  }
  return json as T
}

/** Turn any error-shaped value into display text. */
export function errorText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Lowercase a display name into an upstream slug. */
export function slugify(value: unknown): string {
  return String(value).toLowerCase().replace(/\s+/g, "-")
}

/**
 * Normalize a model id for fuzzy catalog matching (the gateway's canonical
 * slug and OpenRouter's id disagree on hyphens: `zai/…` vs `z-ai/…`).
 */
export function normalizeSlug(value: unknown): string {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Read the routing facts out of one completed gateway response.
 */
export function parseRouting(json: unknown): Routing {
  const payload = unwrapEnvelope<any>(json)
  const message = payload?.choices?.[0]?.message
  // Non-streaming answers put routing on `message`; Cline's streaming
  // answers put the same metadata on a late `delta` frame. Reading only the
  // first spelling made every stream look `unresolved` and prevented the
  // channel verdict from being learned.
  const routing =
    message?.provider_metadata?.gateway?.routing ??
    payload?.provider_metadata?.gateway?.routing ??
    payload?.choices?.[0]?.delta?.provider_metadata?.gateway?.routing ??
    {}
  const direct = typeof payload?.provider === "string" ? payload.provider : null
  const finalProvider = routing.finalProvider ?? (direct === null ? null : slugify(direct))
  return {
    content: typeof message?.content === "string" ? message.content : null,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
    usage: payload?.usage ?? null,
    pipeline: routing.finalProvider ? "planner" : direct === null ? null : "direct",
    canonicalSlug:
      routing.canonicalSlug ??
      (typeof payload?.model === "string" && payload.model.includes("/") ? payload.model : null),
    finalProvider,
    finalProviderName: routing.finalProvider ?? direct,
    fallbacks: Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : [],
    plan: typeof routing.planningReasoning === "string" ? routing.planningReasoning : "",
  }
}

/**
 * Translate a channel name into the spelling one pipeline uses.
 * Unknown names pass through.
 */
export function channelNameFor(name: string, pipeline: "planner" | "direct"): string {
  const needle = normalizeSlug(name)
  for (const [planner, direct] of CHANNEL_ALIASES) {
    if (normalizeSlug(planner) === needle) return pipeline === "direct" ? direct : planner
    if (normalizeSlug(direct) === needle) return pipeline === "planner" ? planner : direct
  }
  return name
}

/**
 * Normalize a configured sort into a wire value or `null`.
 *
 * Both the stored empty string and the documented `none` mean "no sort"; the
 * gateway rejects them with HTTP 400, so both are dropped before the request is
 * built. Any other value passes through, so a genuine typo is named by the
 * gateway's own diagnostic instead of being silently ignored.
 */
export function normalizeSort(value: unknown): string | null {
  if (typeof value !== "string") return null
  const sort = value.trim()
  return sort.length === 0 || sort === "none" ? null : sort
}

/**
 * Normalize a configured pin mode to the one value the router compares against.
 *
 * The panel and the tools write different spellings, so `"strict "` used to
 * display as strict while `buildAttempts` compared the untouched value and ran
 * it as preferred. One normalizer keeps the shown mode and the executed mode
 * the same thing.
 */
export function normalizePinMode(value: unknown): "strict" | "preferred" {
  return String(value ?? "").trim().toLowerCase() === "preferred" ? "preferred" : "strict"
}

/**
 * The channel vocabulary one spelling should be resolved against.
 *
 * The two pipelines publish different channel lists, so the merged list is the
 * wrong basis for an allow-list: it can miss the channel that actually serves
 * the request, which is exactly how an exclusion leaks.
 */
export function knownChannels(meta: ModelMeta | undefined, pipeline: "planner" | "direct"): string[] {
  const scoped = meta?.channels?.[pipeline]
  if (Array.isArray(scoped) && scoped.length > 0) return scoped
  return Array.isArray(meta?.upstreams) ? meta.upstreams : []
}

/**
 * Write one attempt's upstream preference into a request body.
 *
 * Excludes are compiled into an `only` allow-list because the gateway ignores
 * the exclude/ignore fields. Both spellings are written by default: a pin is
 * honored only by the pipeline that owns the spelling, and the pipeline is
 * decided by the gateway and can differ between calls.
 */
export function injectPrefs(
  body: Record<string, any>,
  meta: ModelMeta | undefined,
  attempt: Partial<Attempt> | undefined,
): Record<string, any> {
  const next: Record<string, any> = { ...body }
  const upstream = attempt?.upstream ?? null
  const orderRest = attempt?.orderRest ?? []
  const excludeList = attempt?.excludeList ?? []
  const strict = attempt?.strict !== false
  const sort = normalizeSort(attempt?.sort)
  const excluded = excludeList.filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ""))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  const spell = (names: string[], pipeline: "planner" | "direct") =>
    names.map((name) => channelNameFor(name, pipeline))
  const gatewayAllow =
    excluded.length > 0
      ? knownChannels(meta, "planner").filter((name) => !excludedIds.has(normalizeSlug(name)))
      : null
  const openRouterAllow =
    excluded.length > 0
      ? knownChannels(meta, "direct").filter((name) => !excludedIds.has(normalizeSlug(name)))
      : null
  const pipeline = meta?.pipeline ?? null
  const both = attempt?.spelling !== "detected"
  const useGateway = both || pipeline === "planner" || pipeline === null
  const useOpenRouter = both || pipeline === "direct" || pipeline === null
  const gatewayUsable =
    useGateway && (upstream !== null || sort !== null || (gatewayAllow !== null && gatewayAllow.length > 0))
  const openRouterUsable =
    useOpenRouter &&
    (upstream !== null ||
      sort !== null ||
      excluded.length > 0 ||
      (openRouterAllow !== null && openRouterAllow.length > 0))
  if (!gatewayUsable && !openRouterUsable) return next

  if (gatewayUsable) {
    const gateway: Record<string, any> = {}
    if (upstream !== null) {
      if (strict) gateway.only = spell([upstream], "planner")
      else {
        gateway.order = spell([upstream, ...orderRest], "planner")
        if (gatewayAllow !== null && gatewayAllow.length > 0) gateway.only = spell(gatewayAllow, "planner")
      }
    } else if (gatewayAllow !== null && gatewayAllow.length > 0) {
      gateway.only = spell(gatewayAllow, "planner")
    }
    if (sort !== null) gateway.sort = sort
    next.providerOptions = {
      ...(next.providerOptions ?? {}),
      gateway: { ...(next.providerOptions?.gateway ?? {}), ...gateway },
    }
  }

  if (openRouterUsable) {
    const provider: Record<string, any> = { ...(next.provider ?? {}) }
    if (upstream !== null) {
      if (strict) provider.only = spell([upstream], "direct")
      else {
        provider.order = spell([upstream, ...orderRest], "direct")
        if (openRouterAllow !== null && openRouterAllow.length > 0) provider.only = spell(openRouterAllow, "direct")
      }
    } else if (openRouterAllow !== null && openRouterAllow.length > 0) {
      provider.only = spell(openRouterAllow, "direct")
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    if (excluded.length > 0) provider.ignore = spell(excluded, "direct")
    next.provider = provider
  }
  return next
}

/**
 * Read back whether the router honored one attempt's pin.
 *
 * A 200 is not evidence that the pin was applied: an unknown or unavailable
 * `only` value is dropped by the router, which then serves the request from any
 * channel it likes. The only honest test is the channel the response reports.
 */
export function pinAdherence(attempt: Partial<Attempt> | undefined, routing: Partial<Routing> | undefined): Adherence {
  const expected = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? [])
    .filter((name) => normalizeSlug(name) !== normalizeSlug(expected ?? ""))
    .map(normalizeSlug)
  const raw = routing?.finalProvider ?? null
  const actual = raw === null || raw === undefined || String(raw).length === 0 ? null : normalizeSlug(raw)
  // An excluded channel serving the request is a breach in every mode, and it
  // is the one failure nothing else can reveal: the response is a clean 200.
  if (actual !== null && excluded.includes(actual)) return "violated"
  if (expected === null || expected === undefined || String(expected).length === 0) return "unresolved"
  if (actual === null) return "unresolved"
  if (actual === normalizeSlug(expected)) return "adopted"
  if ((attempt?.orderRest ?? []).map(normalizeSlug).includes(actual)) return "fallback"
  return "not-adopted"
}

/** Whether an adherence reading means the pin was honored, or cannot be judged. */
export function isAdherenceOk(adherence: string | undefined): boolean {
  return adherence === "adopted" || adherence === "fallback" || adherence === "unresolved"
}

/**
 * Name the configuration problems that make a pin impossible to honor.
 */
export function pinWarnings(attempt: Partial<Attempt> | undefined, meta: ModelMeta | undefined): string[] {
  const upstream = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? []).filter(
    (name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ""),
  )
  const excludedIds = new Set(excluded.map(normalizeSlug))
  if (excluded.length === 0) return []
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  if (known.length === 0) {
    return [
      `excludeUnresolved: this model has no channel list yet, so ${excluded.join(
        ", ",
      )} could not be compiled into an allow-list — run cline_pass_probe for it`,
    ]
  }
  const remaining = known.filter((name) => !excludedIds.has(normalizeSlug(name)))
  if (remaining.length === 0 && upstream === null) {
    return [
      `PIN_UNRESOLVED: every known channel is excluded (${known.join(
        ", ",
      )}), so the request falls back to the gateway's own routing`,
    ]
  }
  return []
}

/**
 * Expand one model's pin configuration into the ordered failover candidates.
 */
export function buildAttempts(config: PinConfig | undefined): Attempt[] {
  const listed = (config?.upstreams ?? []).filter((name) => typeof name === "string" && name.length > 0)
  const exclude = (config?.exclude ?? []).filter((name) => typeof name === "string" && name.length > 0)
  const excluded = new Set(exclude.map(normalizeSlug))
  const wanted = listed.filter((name) => !excluded.has(normalizeSlug(name)))
  const strict = normalizePinMode(config?.pinMode) === "strict"
  const sort = normalizeSort(config?.sort)
  const base: Omit<Attempt, "upstream" | "orderRest"> = { strict, sort, excludeList: exclude }
  const attemptBase: Partial<Attempt> = { ...base }
  if (typeof config?.spelling === "string" && config.spelling.length > 0) attemptBase.spelling = config.spelling
  if (wanted.length > 0) {
    return wanted.map((upstream, index) => ({
      ...base,
      ...(attemptBase.spelling === undefined ? {} : { spelling: attemptBase.spelling }),
      upstream,
      orderRest: strict ? [] : wanted.filter((_, other) => other !== index),
    }))
  }
  return [{ ...base, ...(attemptBase.spelling === undefined ? {} : { spelling: attemptBase.spelling }), upstream: null, orderRest: [] }]
}

/**
 * Classify a pinned-request failure into one upstream availability verdict.
 */
export function classifyUpstreamError(message: unknown): string {
  const text = String(message ?? "")
  if (/empty response content/i.test(text)) return "ok"
  if (/429|rate-?limited|temporarily rate/i.test(text)) return "limited"
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(text)) {
    return "bad"
  }
  if (/\b401\b|\b403\b|unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)/i.test(text)) return "auth"
  return "unknown"
}

/**
 * Recover the gateway's own upstream list from a routing-layer error.
 *
 * The probe channels an impossible `only` value, so the router fails before
 * spending a token and names every provider it could have used.
 */
export function extractAvailableProviders(message: unknown, pipeline: "planner" | "direct"): string[] | null {
  const text = String(message ?? "")
  if (pipeline === "planner") {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match === null) return null
    const tokens = (match[1] ?? "")
      .split(/,\s*/)
      .map((token) => token.trim())
      .filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    return tokens.length > 0 ? tokens : null
  }
  const start = text.indexOf("{")
  if (start < 0) return null
  try {
    const parsed = JSON.parse(text.slice(start))
    const list = parsed?.error?.metadata?.available_providers
    return Array.isArray(list) && list.length > 0 ? list.map(String) : null
  } catch {
    return null
  }
}

/**
 * Read the tier-0 channel hint out of a planner's reasoning sentence.
 */
export function parseTier0(plan: unknown): string[] {
  const match = /([\w-]+) won tier 0 over ([^."]+)/.exec(String(plan ?? ""))
  if (match === null) return []
  return [
    ...new Set([
      match[1] as string,
      ...(match[2] ?? "")
        .split(/,\s*|\s+and\s+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ]),
  ]
}

/**
 * Merge upstream channels discovered by several means, keeping order and
 * dropping duplicates.
 */
export function mergeUpstreams(...lists: Array<string[] | null | undefined>): string[] {
  const seen: string[] = []
  for (const list of lists) {
    for (const name of list ?? []) {
      const value = String(name)
      if (value.length > 0 && !seen.includes(value)) seen.push(value)
    }
  }
  return seen.slice(0, MAX_UPSTREAMS)
}

/**
 * Read one delta's reasoning text, tolerating every wire spelling.
 */
export function reasoningOf(delta: any): string | undefined {
  for (const field of ["reasoning", "reasoning_content"]) {
    const value = delta?.[field]
    if (typeof value === "string" && value.length > 0) return value
  }
  const details = delta?.reasoning_details
  if (Array.isArray(details)) {
    const text = details.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    if (text.length > 0) return text
  }
  return undefined
}
