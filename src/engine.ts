/**
 * The engine: account selection, pinned request chains with failover, probing,
 * validation, and request recording. It owns every diagnostic network call, so
 * the proxy, the tools, and the dashboard apply identical pinning semantics.
 *
 * Failover contract: a candidate is abandoned only while nothing has been
 * delivered yet. A non-2xx, a transport failure, or an error payload before the
 * first content delta moves to the next candidate.
 */
import { ClinePassError, errorText, isAuthenticationError } from "./errors.js"
import {
  chatCompletion,
  fetchGatewayCatalog,
  fetchOfficialModels,
  openRouterEndpoints,
  type ChatOptions,
  type OfficialScan,
} from "./gateway.js"
import type { Logger } from "./log.js"
import type { AccountPool } from "./pool.js"
import {
  DEFAULT_CAPABILITIES,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  isAdherenceOk,
  mergeUpstreams,
  normalizeCapabilities,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  routeLocked,
  unwrapEnvelope,
} from "./protocol.js"
import type { ObservationStore } from "./store.js"
import type {
  Adherence,
  Attempt,
  HistoryEntry,
  ModelMeta,
  PinConfig,
  ResolvedAccount,
  Routing,
  TraceRow,
} from "./types.js"

/** How many upstreams are validated concurrently. */
export const VALIDATE_CONCURRENCY = 5

export interface EngineOptions {
  pool: AccountPool
  store: ObservationStore
  pinReader?: (model: string) => PinConfig
  logger: Logger
  attemptTimeoutMs?: number
  probeTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface AttemptOutcome {
  attempt: Partial<Attempt>
  account: ResolvedAccount
  status: number
  ok: boolean
  json: any
  text: string
  ms: number
  routing: Partial<Routing>
  adherence: Adherence | null
  warnings: string[]
  error: string
}

export interface ChainOutcome {
  ok: boolean
  result: AttemptOutcome | null
  trace: TraceRow[]
  error: string
  warnings: string[]
}

/**
 * What the impossible-`only` request proved about one pipeline.
 *
 * `refused` means the router saw the bad channel and named its pool, which also
 * proves a real pin reaches it. `answered` means inference ran anyway: the id
 * drops pins before routing, whatever its metadata claims.
 */
export interface HarvestResult {
  channels: string[] | null
  /**
   * `refused`: the router named its pool (the pin reached it).
   * `answered`: inference ran anyway, so the id drops pins before routing.
   * `gated`: the capability gate itself was refused, which still proves the pin
   * reaches the router but means the model/route lacks the requested capability.
   * `unknown`: neither reading could be taken.
   */
  verdict: "refused" | "answered" | "gated" | "unknown"
}

export interface ProbeResult {
  ok: boolean
  ms: number
  model: string
  error: string
  pipeline: string
  pinnable: boolean
  /** The VMC that fixed this route, or an empty string when routing was free. */
  virtualModel: string
  /** True when the route answered an impossible pin: pins cannot apply. */
  pinInert: boolean
  /** True when the route is a VMC that only honors capability-gated pins. */
  capabilityGated: boolean
  /** One human sentence about why a pin will not work, when it will not. */
  warning: string
  canonicalSlug: string
  lastProvider: string
  upstreams: string[]
  availableProviders: string[]
  tier0: string[]
}

export interface ValidateRow {
  upstream: string
  status: string
  ms: number
  note: string
}

export interface ValidateOutcome {
  results: ValidateRow[]
  summary: Record<string, number>
  cancelled: boolean
}

export interface TestResult {
  ok: boolean
  ms: number
  model: string
  error: string
  targets: string[]
  excluded: string[]
  trace: TraceRow[]
  actual: string
  actualName: string
  pipeline: string
  pinnable: boolean
  virtualModel: string
  pinInert: boolean
  canonicalSlug: string
  account: string
  content: string
  adopted: boolean
  adherence: string
  plan: string
  warnings: string[]
}

export interface AccountTestResult {
  ok: boolean
  authorized: boolean
  ms: number
  model: string
  error: string
}

const EMPTY_ROUTING: Partial<Routing> = {}

export class Engine {
  private readonly pool: AccountPool
  private readonly store: ObservationStore
  private readonly logger: Logger
  private readonly attemptTimeoutMs: number
  private readonly probeTimeoutMs: number
  private readonly fetchImpl: typeof fetch | undefined
  private pinReader: (model: string) => PinConfig
  /** Whether a real reader is wired: then an empty gate is a deliberate choice. */
  private pinReaderWired: boolean

  constructor(options: EngineOptions) {
    this.pool = options.pool
    this.store = options.store
    this.logger = options.logger
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 180000
    this.probeTimeoutMs = options.probeTimeoutMs ?? 60000
    this.fetchImpl = options.fetchImpl
    this.pinReaderWired = options.pinReader !== undefined
    this.pinReader = options.pinReader ?? (() => ({ upstreams: [], exclude: [], pinMode: "strict", sort: "" }))
  }

  /** Replace the function that reads a model's configured pin. */
  setPinReader(reader: (model: string) => PinConfig): void {
    this.pinReader = reader
    this.pinReaderWired = true
  }

  /** The configured pin for one model. */
  currentPin(model: string, override: { upstreams?: string[]; exclude?: string[] } = {}): PinConfig {
    const stored = this.pinReader(model) ?? {}
    return {
      upstreams: Array.isArray(override.upstreams) ? override.upstreams.map(String) : stored.upstreams ?? [],
      exclude: Array.isArray(override.exclude) ? override.exclude.map(String) : stored.exclude ?? [],
      pinMode: stored.pinMode,
      sort: stored.sort ?? "",
      ...(stored.capabilities === undefined ? {} : { capabilities: stored.capabilities }),
      ...(stored.spelling === undefined ? {} : { spelling: stored.spelling }),
    }
  }

  /**
   * The capability gate a planner probe should carry.
   *
   * The pin reader already resolves per-model overrides and the route-wide
   * default; a fresh install with no reader falls back to the shipped gate so
   * the probe still tests what a real request would send.
   */
  capabilityGate(model: string): string[] {
    const configured = normalizeCapabilities(this.pinReader(model)?.capabilities)
    if (configured.length > 0) return configured
    // With a wired reader an empty list is a decision (the gate is off), and the
    // probe must test that same request: defaulting here would report a route as
    // pinnable when the real calls cannot be pinned.
    return this.pinReaderWired ? [] : [...DEFAULT_CAPABILITIES]
  }

  /** Record one request in the observation store. */
  record(model: string, info: Partial<HistoryEntry> & { stream?: boolean }): void {
    this.store.record({
      model,
      provider: null,
      canonical: null,
      account: null,
      ms: 0,
      stream: false,
      ...info,
    } as HistoryEntry)
  }

  private chatOptions(options: ChatOptions): ChatOptions {
    return this.fetchImpl === undefined ? options : { ...options, fetchImpl: this.fetchImpl }
  }

  /**
   * One pinned request, non-streaming.
   */
  async attemptChat(
    model: string,
    body: Record<string, any>,
    attempt: Partial<Attempt>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AttemptOutcome> {
    const account = await this.pool.resolveAccount()
    if (account === undefined) {
      throw new ClinePassError("cline-pass: no usable account credentials", "MISSING_CREDENTIAL")
    }
    const meta = this.store.metaOf(model)
    const pinned = injectPrefs(body, meta, attempt)
    const started = Date.now()
    const result = await chatCompletion(
      this.chatOptions({
        baseURL: account.baseURL,
        apiKey: account.key,
        body: pinned,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.attemptTimeoutMs,
      }),
    )
    const payload = unwrapEnvelope<any>(result.json)
    const failed = result.ok !== true || (payload?.error !== undefined && payload?.choices === undefined)
    const routing = failed ? EMPTY_ROUTING : parseRouting(payload)
    return {
      attempt,
      account,
      status: failed ? (payload?.error === undefined ? result.status : 502) : 200,
      ok: !failed,
      json: payload,
      text: result.text,
      ms: Date.now() - started,
      routing,
      // A 200 says the gateway answered. It does not say the pin was applied,
      // and the router drops an unusable `only` without complaining.
      adherence: failed ? null : pinAdherence(attempt, routing),
      warnings: pinWarnings(attempt, meta),
      error: failed
        ? String(errorText(payload?.error) || result.text.slice(0, 400) || `HTTP ${result.status}`)
        : "",
    }
  }

  /** Merge a gateway error's own provider list into the model's channel list. */
  learnFromError(model: string, message: unknown): void {
    const match = /Available providers are:\s*([^.]+)/.exec(String(message ?? ""))
    if (match === null) return
    const tokens = (match[1] ?? "")
      .split(/,\s*/)
      .map((token) => token.trim())
      .filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    if (tokens.length === 0) return
    const meta = this.store.metaOf(model)
    const current = Array.isArray(meta.upstreams) ? meta.upstreams : []
    // Comparing lengths is false the moment the list is capped: a genuinely new
    // channel replacing a dropped one keeps the length identical.
    if (!tokens.some((token) => !current.includes(token))) return
    this.store.learn(model, { upstreams: mergeUpstreams(current, tokens) })
  }

  /**
   * Run one model's ordered candidate chain until an attempt is both answered
   * and served by the channel the pin asked for.
   *
   * This is the diagnostic path, so it keeps looking past a candidate the
   * router quietly ignored: "the gateway said yes to someone else" is a failure
   * to find out, not an answer.
   */
  async runChain(
    model: string,
    body: Record<string, any>,
    pinConfig: PinConfig,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ChainOutcome> {
    const trace: TraceRow[] = []
    const attempts = buildAttempts(pinConfig)
    let last: AttemptOutcome | null = null
    for (const attempt of attempts) {
      const outcome = await this.attemptChat(model, body, attempt, options)
      const honored = outcome.ok && isAdherenceOk(outcome.adherence ?? undefined)
      const note = !outcome.ok
        ? outcome.error
        : honored
          ? "ok"
          : `pin not adopted: served by ${outcome.routing?.finalProvider ?? "(unknown)"}`
      trace.push({
        upstream: attempt.upstream ?? "(auto)",
        status: outcome.status,
        ms: outcome.ms,
        note: note.slice(0, 160),
      })
      last = outcome
      if (honored) {
        // A successful diagnostic is real evidence for the channel that served
        // it; reflect it in the channel verdicts immediately.
        this.store.learnUpstream(
          model,
          attempt.upstream ?? outcome.routing?.finalProvider ?? null,
          "ok",
          "pin adopted by test",
          outcome.ms,
        )
        return { ok: true, result: outcome, trace, error: "", warnings: outcome.warnings }
      }
      if (!outcome.ok) {
        // A channel that refuses a strict pin is learned as unusable for it.
        if (attempt.upstream !== null && outcome.error !== "") {
          this.store.learnUpstream(
            model,
            attempt.upstream,
            classifyUpstreamError(outcome.error),
            outcome.error,
            outcome.ms,
          )
        }
        if (attempt.upstream === null && (attempt.excludeList ?? []).length > 0 && outcome.error !== "") {
          this.learnFromError(model, outcome.error)
        }
      }
    }
    const error =
      last === null
        ? "no candidate succeeded"
        : last.ok !== true
          ? last.error
          : last.adherence === "violated"
            ? `an excluded channel served the request: ${last.routing?.finalProvider ?? "(unknown)"}`
            : `the gateway ignored the pin: served by ${last.routing?.finalProvider ?? "(unknown)"}`
    return { ok: false, result: last, trace, error, warnings: last?.warnings ?? [] }
  }

  /**
   * Harvest the exact channel list for one pipeline by pinning a channel that
   * cannot exist: the router fails before spending a token and names every
   * provider it could have used.
   *
   * The impossible pin doubles as the only reliable test of whether this id
   * honors pins at all. A route that drops `providerOptions` never sees the
   * bad name, so it answers with an ordinary completion (or with the model's
   * own "empty response content" refusal once a reasoning model burns the
   * budget) instead of a routing refusal.
   *
   * The planner probe carries the capability gate. On a VMC-fixed id that is
   * the difference between a useless answer (the private channel serves it and
   * the impossible `only` is never seen) and a refusal that both proves the pin
   * reaches the router and lists the provider set a capability can choose from.
   * `deepseek/deepseek-v4.1-flash` still answers, which is why the verdict — not
   * the VMC footprint — is what marks a route inert.
   */
  async harvest(
    model: string,
    pipeline: "planner" | "direct",
    account: ResolvedAccount,
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      /** Capability conditions sent with the planner probe. */
      capabilities?: string[]
    } = {},
  ): Promise<HarvestResult> {
    const capabilities = normalizeCapabilities(options.capabilities)
    const base = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 }
    const body =
      pipeline === "planner"
        ? {
            ...base,
            providerOptions: {
              gateway: { only: ["__probe__"], ...(capabilities.length === 0 ? {} : { has: capabilities }) },
            },
          }
        : { ...base, provider: { only: ["__probe__"] } }
    let result: Awaited<ReturnType<typeof chatCompletion>>
    try {
      result = await chatCompletion(
        this.chatOptions({
          baseURL: account.baseURL,
          apiKey: account.key,
          body,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? this.probeTimeoutMs,
        }),
      )
    } catch {
      return { channels: null, verdict: "unknown" }
    }
    const payload = unwrapEnvelope<any>(result.json)
    const message = errorText(payload?.error) || result.text
    const channels = extractAvailableProviders(message, pipeline)
    if (channels !== null) return { channels, verdict: "refused" }
    // A capability refusal is still a routing refusal: the planner read the pin
    // and could not satisfy the gate. It proves the pin reaches the router, but
    // names no pool, so the channel list stays unknown.
    if (/no_capable_providers_available|satisfy the required has conditions/i.test(message)) {
      return { channels: null, verdict: "gated" }
    }
    // Inference ran: the impossible channel was never routed, so a pin cannot
    // reach this route's router either.
    const answered = Array.isArray(payload?.choices) && payload.choices.length > 0
    const burnedTheBudget = /empty response content/i.test(message)
    return { channels: null, verdict: answered || burnedTheBudget ? "answered" : "unknown" }
  }

  /**
   * Probe one model: detect its pipeline, read back the upstream it used, and
   * harvest the channel list each pipeline publishes.
   */
  async probe(model: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProbeResult> {
    const account = await this.pool.resolveAccount()
    if (account === undefined) throw new ClinePassError("cline-pass: no usable account credentials", "MISSING_CREDENTIAL")
    const started = Date.now()
    let result: Awaited<ReturnType<typeof chatCompletion>>
    try {
      result = await chatCompletion(
        this.chatOptions({
          baseURL: account.baseURL,
          apiKey: account.key,
          body: { model, messages: [{ role: "user", content: "Reply with the word OK" }], max_tokens: 256 },
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? this.attemptTimeoutMs,
        }),
      )
    } catch (error) {
      const message = errorText(error)
      this.store.learn(model, { ok: false, lastError: message, lastMs: Date.now() - started })
      return this.probeFailure(model, Date.now() - started, message)
    }
    const payload = unwrapEnvelope<any>(result.json)
    const ms = Date.now() - started
    if (
      !result.ok ||
      (payload?.error !== undefined && payload?.choices === undefined) ||
      !Array.isArray(payload?.choices) ||
      payload.choices.length === 0
    ) {
      const message = String(
        errorText(payload?.error) ||
          payload?.message ||
          result.text.slice(0, 400) ||
          (result.ok ? "gateway returned no completion" : `HTTP ${result.status}`),
      )
      this.store.learn(model, { ok: false, lastError: message, lastMs: ms })
      return this.probeFailure(model, ms, message)
    }
    const routing = parseRouting(payload)
    const pipeline = routing.pipeline
    // A VMC-fixed default route picks one private channel, but that no longer
    // decides whether a pin works: the capability gate can still reach the
    // router. Only the gated impossible-pin verdict can tell the two apart, so
    // the harvest runs even when the VMC looks locked.
    const vmcDefault = routeLocked(routing)
    const capabilities = this.capabilityGate(model)
    const otherPipeline = pipeline === "planner" ? "direct" : pipeline === "direct" ? "planner" : null
    let harvested: string[] | null = null
    let pinDropped = false
    let gateReached = false
    if (pipeline !== null) {
      const outcome = await this.harvest(model, pipeline, account, {
        signal: options.signal,
        timeoutMs: this.probeTimeoutMs,
        capabilities: pipeline === "planner" ? capabilities : [],
      })
      harvested = outcome.channels
      pinDropped = outcome.verdict === "answered"
      gateReached = outcome.verdict === "refused" || outcome.verdict === "gated"
    }
    let otherHarvested: string[] | null = null
    if (otherPipeline !== null) {
      // Only the detected pipeline's verdict says anything about pinning: the
      // other spelling is, by definition, not the one this route reads, so its
      // request is expected to run unpinned and answer.
      otherHarvested = (
        await this.harvest(model, otherPipeline, account, {
          signal: options.signal,
          timeoutMs: this.probeTimeoutMs,
        })
      ).channels
    }
    // A route that answers even a capability-gated impossible pin proves it
    // never reads provider options. That is the only real lock.
    const lockedRoute = pinDropped
    // The VMC path is the one that needs the gate; recording it lets the UI say
    // why a pin works instead of repeating the old "VMC = unpinnable" story.
    const capabilityGated = vmcDefault && gateReached
    let endpoints: Awaited<ReturnType<typeof openRouterEndpoints>>["endpoints"] = []
    let openrouterSlug: string | null = null
    if (pipeline !== "planner" && typeof routing.canonicalSlug === "string") {
      const detail = await openRouterEndpoints(routing.canonicalSlug, {
        signal: options.signal,
        timeoutMs: this.probeTimeoutMs,
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      })
      endpoints = detail.endpoints
      openrouterSlug = detail.slug
    }
    const previous = this.store.metaOf(model)
    const upstreamDetail = { ...(previous.upstreamDetail ?? {}) }
    for (const entry of endpoints) upstreamDetail[entry.slug] = entry
    const discovered =
      pipeline === "planner"
        ? mergeUpstreams(harvested, routing.fallbacks)
        : mergeUpstreams(routing.fallbacks, harvested, Object.keys(upstreamDetail))
    // The channel that just served the probe is the highest-confidence entry
    // there is, so it goes first, translated into the pipeline's vocabulary.
    const servedRaw =
      typeof routing.finalProvider === "string" && routing.finalProvider.length > 0 ? routing.finalProvider : null
    const served = servedRaw === null ? [] : [pipeline === null ? servedRaw : channelNameFor(servedRaw, pipeline)]
    const combined = mergeUpstreams(served, discovered, otherHarvested)
    // A probe that discovered nothing must not wipe what an earlier one found.
    const upstreams = combined.length > 0 ? combined : previous.upstreams ?? []
    const channels = { ...(previous.channels ?? {}) }
    if (pipeline !== null) {
      const scoped = mergeUpstreams(served, harvested)
      if (scoped.length > 0) channels[pipeline] = scoped
    }
    if (otherPipeline !== null && Array.isArray(otherHarvested) && otherHarvested.length > 0) {
      channels[otherPipeline] = otherHarvested
    }
    const tier0 = [...new Set([...(previous.tier0 ?? []), ...parseTier0(routing.plan)])]
    const meta = this.store.learn(model, {
      ok: true,
      pipeline,
      // "Pinnable" means a pin can actually reach the router. On a planner
      // route only the capability-gated impossible pin proves it; a VMC by
      // itself no longer disqualifies, because the gate reaches its router.
      pinnable: pipeline !== null && !lockedRoute,
      virtualModel: routing.virtualModel,
      pinInert: lockedRoute,
      capabilityGated,
      availableProviders: harvested ?? previous.availableProviders ?? [],
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      openrouterSlug: openrouterSlug ?? previous.openrouterSlug ?? null,
      upstreamDetail,
      upstreams,
      channels,
      staleAt: combined.length === 0 && upstreams.length > 0 ? Date.now() : 0,
      tier0,
      lastProvider: routing.finalProvider ?? previous.lastProvider ?? null,
      lastMs: ms,
      probedAt: Date.now(),
      lastError: "",
    })
    return {
      ok: true,
      ms,
      model,
      error: "",
      pipeline: meta.pipeline ?? "",
      pinnable: meta.pinnable === true,
      virtualModel: meta.virtualModel ?? "",
      pinInert: meta.pinInert === true,
      capabilityGated: meta.capabilityGated === true,
      warning: meta.pinInert !== true
        ? ""
        : meta.virtualModel !== null && meta.virtualModel !== undefined && meta.virtualModel !== ""
          ? `this id routes through VMC ${meta.virtualModel} and answered even a capability-gated impossible pin, so pins cannot reach its router. Pinning needs an id whose provider list the gateway evaluates`
          : `this id answered an impossible pin instead of refusing it, so the gateway drops the pin before routing: pins cannot apply on it`,
      canonicalSlug: meta.canonicalSlug ?? "",
      lastProvider: meta.lastProvider ?? "",
      upstreams: meta.upstreams ?? [],
      availableProviders: meta.availableProviders ?? [],
      tier0: meta.tier0 ?? [],
    }
  }

  private probeFailure(model: string, ms: number, error: string): ProbeResult {
    return {
      ok: false,
      ms,
      model,
      error,
      pipeline: "",
      pinnable: false,
      virtualModel: "",
      pinInert: false,
      capabilityGated: false,
      warning: "",
      canonicalSlug: "",
      lastProvider: "",
      upstreams: [],
      availableProviders: [],
      tier0: [],
    }
  }

  /**
   * Test every known channel of a model once and record the verdicts.
   *
   * A channel counts as usable only when the response names it as the one that
   * served the request. The previous rule — any payload carrying `choices` —
   * marked every channel available while the pin was being ignored, and those
   * verdicts then fed the exclusion allow-list.
   */
  async validate(model: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ValidateOutcome> {
    const meta = this.store.metaOf(model)
    const list = Array.isArray(meta.upstreams) ? meta.upstreams : []
    const capabilities = this.capabilityGate(model)
    const results: ValidateRow[] = []
    for (let index = 0; index < list.length; index += VALIDATE_CONCURRENCY) {
      if (options.signal?.aborted === true) break
      const batch = list.slice(index, index + VALIDATE_CONCURRENCY)
      const settled = await Promise.all(
        batch.map(async (upstream): Promise<ValidateRow> => {
          const started = Date.now()
          // The gate is part of the request a real pin sends, so a channel that
          // only looks reachable without it is not actually usable.
          const attempt: Attempt = {
            upstream,
            strict: true,
            sort: null,
            orderRest: [],
            excludeList: [],
            ...(capabilities.length === 0 ? {} : { capabilities }),
          }
          const base = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 }
          const body = injectPrefs(base, meta, attempt)
          try {
            const account = await this.pool.resolveAccount()
            if (account === undefined) {
              return { upstream, status: "unknown", ms: Date.now() - started, note: "no usable account" }
            }
            const result = await chatCompletion(
              this.chatOptions({
                baseURL: account.baseURL,
                apiKey: account.key,
                body,
                signal: options.signal,
                timeoutMs: options.timeoutMs ?? this.probeTimeoutMs,
              }),
            )
            const payload = unwrapEnvelope<any>(result.json)
            const ms = Date.now() - started
            let status = "unknown"
            let note = ""
            if (!result.ok || (payload?.error !== undefined && payload?.choices === undefined)) {
              note = String(errorText(payload?.error) || result.text || `HTTP ${result.status}`)
              status = isAuthenticationError(note, result.status) ? "auth" : classifyUpstreamError(note)
            } else if (payload?.choices !== undefined) {
              const routing = parseRouting(payload)
              const adherence = pinAdherence(attempt, routing)
              if (adherence === "adopted") {
                status = "ok"
              } else if (adherence === "unresolved") {
                note = "the response did not name the serving channel; the pin could not be verified"
              } else {
                status = "not-adopted"
                note = `pin not adopted: served by ${routing.finalProvider ?? "(unknown)"}`
              }
            }
            return { upstream, status, ms, note: note.slice(0, 160) }
          } catch (error) {
            return { upstream, status: "unknown", ms: Date.now() - started, note: errorText(error).slice(0, 160) }
          }
        }),
      )
      for (const result of settled) {
        this.store.learnUpstream(model, result.upstream, result.status, result.note, result.ms, { includeUnknown: true })
        results.push(result)
      }
    }
    const summary: Record<string, number> = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 }
    for (const result of results) {
      // `not-adopted` has no summary column of its own: it means "not usable as
      // a pin", which is what `bad` already counts.
      const bucket = result.status === "not-adopted" ? "bad" : result.status
      summary[bucket] = (summary[bucket] ?? 0) + 1
    }
    this.store.learn(model, { validatedAt: Date.now() })
    return { results, summary, cancelled: options.signal?.aborted === true }
  }

  /**
   * Send one small chat through a (possibly temporary) pin configuration and
   * report what served it. Nothing is persisted.
   */
  async test(
    model: string,
    options: { upstreams?: string[]; exclude?: string[]; signal?: AbortSignal } = {},
  ): Promise<TestResult> {
    const pin = this.currentPin(model, { upstreams: options.upstreams, exclude: options.exclude })
    const started = Date.now()
    const outcome = await this.runChain(
      model,
      { model, messages: [{ role: "user", content: "Reply with the word OK" }], max_tokens: 256 },
      pin,
      { signal: options.signal, timeoutMs: this.attemptTimeoutMs },
    )
    const ms = Date.now() - started
    const warnings = outcome.warnings ?? []
    const targets = pin.upstreams ?? []
    const excluded = pin.exclude ?? []
    const routing = outcome.result?.routing ?? {}
    const account = outcome.result?.account?.name ?? ""
    const meta = this.store.metaOf(model)
    const virtualModel = typeof meta.virtualModel === "string" ? meta.virtualModel : ""
    const pinInert = meta.pinInert === true
    if (!outcome.ok) {
      this.record(model, {
        provider: routing.finalProvider ?? null,
        attempts: outcome.trace.map((row) => row.upstream),
        ms,
        stream: false,
        error: outcome.error,
        adherence: outcome.result?.adherence ?? "",
        account: account === "" ? null : account,
      })
      return {
        ok: false,
        ms,
        model,
        error: outcome.error,
        targets,
        excluded,
        trace: outcome.trace,
        actual: routing.finalProvider ?? "",
        actualName: routing.finalProviderName ?? "",
        pipeline: routing.pipeline ?? "",
        pinnable: routing.pipeline !== null && routing.pipeline !== undefined && !pinInert,
        virtualModel,
        pinInert,
        canonicalSlug: routing.canonicalSlug ?? "",
        account,
        content: "",
        adopted: false,
        adherence: outcome.result?.adherence ?? "",
        plan: "",
        warnings,
      }
    }
    this.record(model, {
      provider: routing.finalProvider,
      canonical: routing.canonicalSlug,
      attempts: outcome.trace.map((row) => row.upstream),
      ms,
      stream: false,
      error: null,
      adherence: outcome.result?.adherence ?? "",
      account,
    })
    return {
      ok: true,
      ms,
      model,
      error: "",
      targets,
      excluded,
      trace: outcome.trace,
      actual: routing.finalProvider ?? "",
      actualName: routing.finalProviderName ?? "",
      pipeline: routing.pipeline ?? "",
      pinnable: routing.pipeline !== null && routing.pipeline !== undefined && !pinInert,
      virtualModel,
      pinInert,
      canonicalSlug: routing.canonicalSlug ?? "",
      account,
      content: String(routing.content ?? "").slice(0, 120),
      adopted: outcome.result?.adherence === "adopted",
      adherence: outcome.result?.adherence ?? "",
      plan: routing.plan ?? "",
      warnings,
    }
  }

  /**
   * Check one account key against the gateway with a single small request.
   *
   * A key that authenticates but whose model still errors counts as authorized:
   * only a real authentication failure is reported as one.
   */
  async testAccount(options: {
    key: string
    baseURL: string
    model: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<AccountTestResult> {
    const started = Date.now()
    try {
      const result = await chatCompletion(
        this.chatOptions({
          baseURL: options.baseURL,
          apiKey: options.key,
          body: { model: options.model, messages: [{ role: "user", content: "Say OK" }], max_tokens: 512 },
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? this.probeTimeoutMs,
        }),
      )
      const payload = unwrapEnvelope<any>(result.json)
      const ms = Date.now() - started
      const message = String(
        errorText(payload?.error) ||
          payload?.message ||
          (result.ok ? "" : result.text.slice(0, 400)) ||
          (result.ok ? "" : `HTTP ${result.status}`),
      )
      if (isAuthenticationError(message, result.status)) {
        return { ok: false, authorized: false, ms, model: options.model, error: message || `HTTP ${result.status}` }
      }
      const hasCompletion = result.ok && Array.isArray(payload?.choices) && payload.choices.length > 0
      // A structured model/quota refusal can establish authorization without a
      // completion. Server failures, HTML and malformed success bodies cannot.
      const modelError =
        /empty response content|\bmodel(?:id)?\b|context|max[_ -]?tokens|reasoning|no (?:allowed|available) providers/i.test(
          message,
        )
      const modelRefusal =
        payload?.error !== undefined &&
        ([402, 429].includes(result.status) ||
          ((result.ok || [400, 404, 422].includes(result.status)) && modelError))
      const authorized = hasCompletion || modelRefusal
      return {
        ok: authorized,
        authorized,
        ms,
        model: options.model,
        error: authorized && hasCompletion ? "" : message || "gateway returned no completion; authorization could not be verified",
      }
    } catch (error) {
      return { ok: false, authorized: false, ms: Date.now() - started, model: options.model, error: errorText(error) }
    }
  }

  /** Refresh the gateway's own catalog ids. */
  async gatewayCatalog(options: { signal?: AbortSignal } = {}): Promise<string[]> {
    const account = await this.pool.resolveAccount()
    if (account === undefined) return []
    return await fetchGatewayCatalog({
      baseURL: account.baseURL,
      apiKey: account.key,
      signal: options.signal,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    })
  }

  /** Refresh the official subscription model list. */
  async officialModels(options: { signal?: AbortSignal } = {}): Promise<OfficialScan> {
    return await fetchOfficialModels({
      signal: options.signal,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    })
  }

  /** The store this engine observes. */
  get observations(): ObservationStore {
    return this.store
  }

  /** The pool this engine routes through. */
  get accounts(): AccountPool {
    return this.pool
  }

  /** The logger, for callers that share the engine's voice. */
  get log(): Logger {
    return this.logger
  }
}

/** Create the engine. */
export function createEngine(options: EngineOptions): Engine {
  return new Engine(options)
}
