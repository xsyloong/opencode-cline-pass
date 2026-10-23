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
export const BUILD_TAG = "opencode-2"

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

/**
 * The capability vocabulary the planner accepts in `providerOptions.gateway.has`.
 *
 * The list is closed: anything else is refused with HTTP 400 ("has entries must
 * be one of …"), which is why a configured value is passed through untouched
 * rather than quietly dropped — a typo should be named by the gateway, not
 * silently turn the pin off.
 */
export const CAPABILITY_VALUES = [
  "free",
  "implicit-caching",
  "reasoning",
  "structured-output",
  "tool-use",
  "vision",
] as const

/** Weight-format conditions are also accepted: `quantization:fp8`, `!quantization:bf16`. */
export const WEIGHT_CONDITION = /^!?quantization:[a-z0-9._-]+$/i

/**
 * The capability gate sent with a pin by default.
 *
 * `vision` is supported by every current coding model on this route and, being
 * a positive condition, is what excludes the VMC's capability-less private
 * channel so the allow-list is finally evaluated. A text-only model needs
 * `tool-use` (or another capability it actually has) — see `pinCapabilities`.
 */
export const DEFAULT_CAPABILITIES = ["vision"]

/**
 * Normalize a capability list: trim, lowercase, de-duplicate, keep order.
 *
 * Unknown entries are kept. The planner's own 400 names the whole vocabulary,
 * which is a better diagnostic than a silently weakened pin.
 */
export function normalizeCapabilities(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    const cap = String(raw ?? "").trim().toLowerCase()
    if (cap.length === 0 || seen.has(cap)) continue
    seen.add(cap)
    out.push(cap)
  }
  // An explicit empty list is kept: it is how the gate is switched off.
  return out
}

/** Whether one capability entry is in the planner's vocabulary. */
export function isKnownCapability(value: unknown): boolean {
  const cap = String(value ?? "").trim().toLowerCase()
  return (CAPABILITY_VALUES as readonly string[]).includes(cap) || WEIGHT_CONDITION.test(cap)
}

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
  // A VMC fixes the provider list before routing happens, so its id is the one
  // reliable signal that a pin cannot be honored on this route.
  const virtual =
    message?.provider_metadata?.gateway?.virtualModelConfig?.modelId ??
    payload?.provider_metadata?.gateway?.virtualModelConfig?.modelId ??
    payload?.choices?.[0]?.delta?.provider_metadata?.gateway?.virtualModelConfig?.modelId ??
    null
  const virtualModel =
    typeof virtual === "string" && virtual.length > 0
      ? virtual
      : typeof payload?.model === "string" && payload.model.startsWith("vmc/")
        ? payload.model.slice("vmc/".length)
        : null
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
    virtualModel,
  }
}

/**
 * Whether the gateway routed through a VMC that offered no fallbacks.
 *
 * This describes the *default* route — one private channel — not what a pin can
 * do. A capability-gated pin (`has` + `only`) still reaches the router on these
 * ids, so this is a display hint; `pinInert` is the field that says a pin is
 * actually dropped.
 */
export function routeLocked(routing: Partial<Routing> | undefined): boolean {
  const virtual = routing?.virtualModel ?? null
  if (virtual === null || virtual.length === 0) return false
  return (routing?.fallbacks ?? []).length === 0
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
 *
 * A `preferred` attempt also carries `only`: the planner pipeline drops `order`
 * entirely, so writing only `order` produced a request that looked pinned and
 * behaved exactly like automatic routing. `order` is still written — it is the
 * cheaper spelling on routers that honor it — but the allow-list is what makes
 * the pin real.
 *
 * `has` travels with every planner allow-list. A VMC-fixed id exposes one
 * capability-less private channel, and the planner only evaluates `only` once a
 * positive capability condition has excluded that channel; without the gate the
 * allow-list is dropped and the pin silently does nothing (verified three
 * rounds alternating on/off, 2026-10). The condition is deliberately mild
 * (`vision` by default) — its job is to open the gate, not to narrow the pool.
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
  const capabilities = normalizeCapabilities(attempt?.capabilities)
  const excluded = excludeList.filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ""))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  const spell = (names: string[], pipeline: "planner" | "direct") =>
    names.map((name) => channelNameFor(name, pipeline))
  // The candidate set one non-strict attempt is allowed to use. `buildAttempts`
  // already dropped excluded names from it, so it never needs re-filtering.
  const candidates = upstream === null ? [] : [upstream, ...orderRest]
  // A capability-gated harvest publishes the exact set the gate can choose from.
  // The VMC's private channel is not in it, yet it is the channel that served
  // the probe, so it heads the discovered list. Leaving it in a *derived*
  // allow-list would turn an exclusion into a 400 for a channel the caller never
  // named. Explicitly pinned channels are left alone: a 400 there is the honest
  // answer, and pinning the private channel is a no-op anyway.
  const gatedSet =
    capabilities.length > 0 && meta?.capabilityGated === true && Array.isArray(meta.availableProviders) && meta.availableProviders.length > 0
      ? new Set(meta.availableProviders.map((name) => normalizeSlug(name)))
      : null
  const inGate = (name: string): boolean => gatedSet === null || gatedSet.has(normalizeSlug(name))
  const gatewayAllow =
    excluded.length > 0
      ? knownChannels(meta, "planner").filter((name) => !excludedIds.has(normalizeSlug(name)) && inGate(name))
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
    useGateway &&
    (upstream !== null || sort !== null || (gatewayAllow !== null && gatewayAllow.length > 0))
  const openRouterUsable =
    useOpenRouter &&
    (upstream !== null ||
      sort !== null ||
      excluded.length > 0 ||
      (openRouterAllow !== null && openRouterAllow.length > 0))
  if (!gatewayUsable && !openRouterUsable) return next

  if (gatewayUsable) {
    const gateway: Record<string, any> = {}
    if (upstream !== null && candidates.length > 0) {
      const names = spell(candidates, "planner")
      if (strict) gateway.only = spell([upstream], "planner")
      else {
        gateway.order = names
        gateway.only = names
      }
    } else if (gatewayAllow !== null && gatewayAllow.length > 0) {
      gateway.only = spell(gatewayAllow, "planner")
    }
    if (sort !== null) gateway.sort = sort
    // The gate goes with an allow-list, never on its own: `has` without `only`
    // still changes the route (it drops the private channel), which is not what
    // a caller asked for.
    if (capabilities.length > 0 && (gateway.only !== undefined || gateway.order !== undefined)) {
      gateway.has = capabilities
    }
    next.providerOptions = {
      ...(next.providerOptions ?? {}),
      gateway: { ...(next.providerOptions?.gateway ?? {}), ...gateway },
    }
  }

  if (openRouterUsable) {
    const provider: Record<string, any> = { ...(next.provider ?? {}) }
    if (upstream !== null && candidates.length > 0) {
      const names = spell(candidates, "direct")
      if (strict) provider.only = spell([upstream], "direct")
      else {
        provider.order = names
        provider.only = names
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
  const warnings: string[] = []
  // A locked route is the higher-order problem: it makes every other pin
  // question moot. The probe decides this with the gate on, so an id that is
  // merely VMC-routed no longer lands here — only one that answered even a
  // capability-gated impossible pin does.
  if (meta?.pinInert === true) {
    const vmc = typeof meta.virtualModel === "string" && meta.virtualModel.length > 0 ? meta.virtualModel : ""
    warnings.push(
      vmc === ""
        ? "PIN_INERT: this id answered an impossible pin instead of refusing it, so the gateway drops the pin before routing and pins cannot apply. A model id whose routing the gateway exposes (a vendor/model slug) can be pinned, but it bills per token at list price instead of the subscription rate — switch only if you need a specific provider"
        : `PIN_INERT: this id routes through VMC ${vmc} and still answered a capability-gated impossible pin, so pins cannot reach its router. Pinning needs an id whose provider list the gateway exposes`,
    )
  } else {
    const capabilities = normalizeCapabilities(attempt?.capabilities)
    const pinned = attempt?.upstream !== null && attempt?.upstream !== undefined
    // Only the planner path needs the gate. A confirmed direct route ignores
    // `providerOptions` entirely, so demanding one there would be noise.
    const plannerPath = meta?.pipeline === "planner" || (meta?.pipeline === undefined && Boolean(meta?.virtualModel))
    if (pinned && capabilities.length === 0 && plannerPath) {
      warnings.push(
        "PIN_GATE_MISSING: the planner drops `only` on a VMC-fixed id unless a positive capability condition travels with it (`providerOptions.gateway.has`). `pinCapabilities` is empty, so this pin can be ignored — set it to a capability the model has, e.g. [\"vision\"] or [\"tool-use\"]",
      )
    }
  }
  const upstream = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? []).filter(
    (name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ""),
  )
  const excludedIds = new Set(excluded.map(normalizeSlug))
  if (excluded.length === 0) return warnings
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  if (known.length === 0) {
    warnings.push(
      `excludeUnresolved: this model has no channel list yet, so ${excluded.join(
        ", ",
      )} could not be compiled into an allow-list — run cline_pass_probe for it`,
    )
    return warnings
  }
  const remaining = known.filter((name) => !excludedIds.has(normalizeSlug(name)))
  if (remaining.length === 0 && upstream === null) {
    warnings.push(
      `PIN_UNRESOLVED: every known channel is excluded (${known.join(
        ", ",
      )}), so the request falls back to the gateway's own routing`,
    )
  }
  return warnings
}

/**
 * Expand one model's pin configuration into the ordered failover candidates.
 *
 * The two modes buy different things, because the wire only honors one of them:
 *
 * - `strict` can be expressed exactly — `only: [one channel]` — so it expands
 *   into one hard attempt per candidate and a failure is reported honestly.
 * - `preferred` cannot. The planner pipeline drops `order` outright (verified
 *   against the live gateway: every `order` permutation routes identically), so
 *   an ordered list would leave the request completely unpinned. It compiles
 *   into one attempt over the whole candidate *set*, which the router does
 *   honor and will fail over within, followed by one unpinned attempt that
 *   keeps the permissive half of "preferred": if the whole set refuses, the
 *   gateway may still serve the request from anywhere.
 *
 * Every attempt carries the capability gate, because a planner allow-list
 * without `has` is what the VMC path silently discards.
 */
export function buildAttempts(config: PinConfig | undefined): Attempt[] {
  const listed = (config?.upstreams ?? []).filter((name) => typeof name === "string" && name.length > 0)
  const exclude = (config?.exclude ?? []).filter((name) => typeof name === "string" && name.length > 0)
  const excluded = new Set(exclude.map(normalizeSlug))
  const wanted = listed.filter((name) => !excluded.has(normalizeSlug(name)))
  const strict = normalizePinMode(config?.pinMode) === "strict"
  const sort = normalizeSort(config?.sort)
  const capabilities = normalizeCapabilities(config?.capabilities)
  const base: Omit<Attempt, "upstream" | "orderRest"> = {
    strict,
    sort,
    excludeList: exclude,
    ...(capabilities.length === 0 ? {} : { capabilities }),
  }
  const attemptBase: Partial<Attempt> = { ...base }
  if (typeof config?.spelling === "string" && config.spelling.length > 0) attemptBase.spelling = config.spelling
  const spellingOf = (): Partial<Attempt> =>
    attemptBase.spelling === undefined ? {} : { spelling: attemptBase.spelling }
  if (wanted.length > 0) {
    if (!strict) {
      return [
        { ...base, ...spellingOf(), upstream: wanted[0]!, orderRest: wanted.slice(1) },
        { ...base, ...spellingOf(), upstream: null, orderRest: [] },
      ]
    }
    return wanted.map((upstream) => ({ ...base, ...spellingOf(), upstream, orderRest: [] }))
  }
  return [{ ...base, ...spellingOf(), upstream: null, orderRest: [] }]
}

/**
 * Classify a pinned-request failure into one upstream availability verdict.
 */
export function classifyUpstreamError(message: unknown): string {
  const text = String(message ?? "")
  if (/empty response content/i.test(text)) return "ok"
  if (/429|rate-?limited|temporarily rate/i.test(text)) return "limited"
  // A capability refusal means the channel is real but cannot satisfy the gate
  // the pin asked for; that is a property of the channel, not a transient fault.
  if (/no_capable_providers_available|satisfy the required has conditions/i.test(text)) return "bad"
  if (/has entries must be one of/i.test(text)) return "bad"
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
