/**
 * The management dashboard: the opencode equivalent of dsh-cline-pass's setup
 * panel. It is a thin projection, never a second source of truth: reads go
 * through the live config and the observation store, and writes go through the
 * same control surface the tools use. Only lossless JSON crosses the wire;
 * credentials are reported as a masked hint, never as a value.
 */
import { accountProfileFor, maskKey } from "./accounts.js"
import { wireModelId } from "./catalog.js"
import type { Control } from "./control.js"
import type { Engine } from "./engine.js"
import { fetchDailyUsage, fetchProfile, fetchUsageLimits } from "./gateway.js"
import type { Logger } from "./log.js"
import { BUILD_TAG, normalizePinMode } from "./protocol.js"
import type { ObservationStore } from "./store.js"
import type { HistoryEntry, ModelMeta, PinProfile, UsageReading } from "./types.js"

/** Collapse a value into one display line. */
export function firstLine(value: unknown, max = 200): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

export interface ProjectedModel {
  id: string
  displayName: string
  pipeline: string
  pinnable: boolean
  hidden: boolean
  pinMode: string
  sort: string
  pinned: string[]
  excluded: string[]
  upstreams: string[]
  upstreamStatus: Array<{ upstream: string; status: string; ms: number; note: string; checkedAt: number }>
  lastProvider: string
  lastMs: number
  probedAt: number
  validatedAt: number
}

/** Project one model from the live configuration plus what the store observed. */
export function projectModel(
  model: string,
  pin: Partial<PinProfile> | undefined,
  meta: ModelMeta | undefined,
  hidden = false,
): ProjectedModel {
  const upstreamStatus = Object.entries(meta?.upstreamStatus ?? {}).map(([upstream, verdict]) => ({
    upstream: String(upstream),
    status: String(verdict?.status ?? "unknown"),
    ms: Number(verdict?.ms ?? 0),
    note: firstLine(verdict?.note, 160),
    checkedAt: Number(verdict?.checkedAt ?? 0),
  }))
  return {
    id: String(model),
    displayName: String(model).replace(/^cline-pass\//, ""),
    pipeline: String(meta?.pipeline ?? ""),
    pinnable: meta?.pinnable === true,
    hidden: hidden === true,
    // The executed mode, not a second opinion about it: `buildAttempts` reads
    // the same normalizer, so what this shows is what a request will do.
    pinMode: normalizePinMode(pin?.pinMode),
    sort: String(pin?.sort ?? ""),
    pinned: Array.isArray(pin?.upstreams) ? pin.upstreams.map(String) : [],
    excluded: Array.isArray(pin?.exclude) ? pin.exclude.map(String) : [],
    upstreams: Array.isArray(meta?.upstreams) ? meta.upstreams.map(String) : [],
    upstreamStatus,
    lastProvider: String(meta?.lastProvider ?? ""),
    lastMs: Number(meta?.lastMs ?? 0),
    probedAt: Number(meta?.probedAt ?? 0),
    validatedAt: Number(meta?.validatedAt ?? 0),
  }
}

export interface DashboardOptions {
  control: Control
  engine: Engine
  store: ObservationStore
  logger: Logger
  /** The dashboard's own address, shown in the header and state. */
  dashboardUrl: string
  /** Injected transport, for tests and hosts that provide their own fetch. */
  fetchImpl?: typeof fetch
}

export type DashboardAction = (payload: any) => Promise<any>

/**
 * Build the dashboard's JSON API over the plugin's control surface.
 * @returns an endpoint table: `name -> (payload) => Promise<json>`.
 */
export function createDashboardApi(options: DashboardOptions): Record<string, DashboardAction> {
  const { control, engine, store, fetchImpl } = options
  const readConfig = () => control.readConfig()

  /** The model id a payload names, or a helpful refusal. */
  const modelOf = (payload: any): string => {
    const model = wireModelId(String(payload?.model ?? ""))
    if (model.length === 0) throw new Error("this action needs a `model` id")
    return model
  }

  /** One account as the dashboard shows it: never the key itself. */
  const accountView = async () => {
    const cfg = readConfig()
    const declared = new Set(Object.keys(cfg.accounts ?? {}))
    return (await control.accountsWithKeys()).map((account) => ({
      ...account,
      declared: declared.has(String(account.key)),
    }))
  }

  /** The whole dashboard snapshot in one round trip. */
  async function state(): Promise<Record<string, unknown>> {
    const cfg = readConfig()
    const accounts = await accountView()
    const hidden = new Set((cfg.hiddenModels ?? []).map(String))
    const models = (cfg.knownModels ?? []).map((id) =>
      projectModel(id, cfg.perModel?.[id] ?? {}, store.metaOf(id), hidden.has(String(id))),
    )
    const effectiveAccount = await control.effectiveAccount()
    const usable = effectiveAccount !== "" && accounts.some((account) => account.keyConfigured && account.enabled)
    return {
      provider: control.providerName,
      displayName: control.displayName,
      baseURL: String(cfg.baseURL ?? ""),
      settingsAvailable: control.settingsAvailable(),
      configPath: control.configPath,
      ...(control.configError === undefined ? {} : { configError: control.configError }),
      accountMode: cfg.accountMode === "roundrobin" ? "roundrobin" : "single",
      activeAccount: String(cfg.activeAccount ?? ""),
      effectiveAccount,
      accounts,
      ready: usable,
      models,
      pinnedModels: models.filter((model) => model.pinned.length > 0).length,
      hiddenModels: models.filter((model) => model.hidden).length,
      usage: store.usage(),
      catalogCount: Number(store.catalog()?.ids?.length ?? 0),
      historySize: store.historySize(),
      historyRevision: store.historyRevision(),
      exposeTools: cfg.exposeTools !== false,
      build: BUILD_TAG,
      dashboardUrl: options.dashboardUrl,
    }
  }

  /**
   * Read every enabled account's official quota windows. One reading per
   * account, because the windows belong to the account: a pool in round-robin
   * mode has no single "current" quota.
   */
  async function usage(): Promise<Record<string, unknown>> {
    const accounts = await control.usageAccounts()
    if (accounts.length === 0) throw new Error("every configured Cline Pass account is disabled; enable one first")
    const readings: UsageReading[] = await Promise.all(
      accounts.map(async (account) => {
        const label = {
          account: account.name,
          displayName: String(account.displayName ?? "") || String(account.name),
        }
        if (account.keyConfigured !== true) {
          return { ...label, ok: false, limits: [], error: `no API key stored for ${account.name}` }
        }
        const result = await fetchUsageLimits({
          baseURL: account.baseURL,
          apiKey: account.key,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        })
        return { ...label, ...result }
      }),
    )
    store.setUsage({ ok: readings.some((reading) => reading.ok), accounts: readings })
    return { ...(await state()), usage: store.usage() }
  }

  /** Per-day/per-model usage for the last 30 days, one reading per account. */
  async function usageDaily(payload: any): Promise<Record<string, unknown>> {
    const accounts = await control.usageAccounts()
    const now = Date.now()
    const startDate =
      typeof payload?.startDate === "string" && payload.startDate.length > 0
        ? payload.startDate
        : new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)
    const endDate =
      typeof payload?.endDate === "string" && payload.endDate.length > 0
        ? payload.endDate
        : new Date(now).toISOString().slice(0, 10)
    const results = await Promise.all(
      accounts.map(async (account) => {
        if (account.keyConfigured !== true) {
          return { account: account.name, displayName: account.displayName, ok: false, error: "no API key stored", rows: [] }
        }
        const profile = await fetchProfile({
          baseURL: account.baseURL,
          apiKey: account.key,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        })
        if (!profile.ok) {
          return { account: account.name, displayName: account.displayName, ok: false, error: profile.error, rows: [] }
        }
        const daily = await fetchDailyUsage({
          baseURL: account.baseURL,
          apiKey: account.key,
          userId: profile.id,
          startDate,
          endDate,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        })
        return {
          account: account.name,
          displayName: account.displayName,
          ok: daily.ok,
          error: daily.error,
          rows: daily.rows,
        }
      }),
    )
    return { startDate, endDate, accounts: results, fetchedAt: Date.now() }
  }

  /** Show or hide one model in every picker this route feeds. */
  async function modelVisibility(payload: any): Promise<Record<string, unknown>> {
    const model = modelOf(payload)
    const cfg = readConfig()
    if (!(cfg.knownModels ?? []).map(String).includes(model)) {
      throw new Error(`${JSON.stringify(model)} is not one of this route's subscription models`)
    }
    const hidden = new Set((cfg.hiddenModels ?? []).map(String))
    if (payload?.visible === false) hidden.add(model)
    else hidden.delete(model)
    await control.updateConfig({ hiddenModels: [...hidden] })
    await control.refreshModels()
    return { model, visible: !hidden.has(model), ...(await state()) }
  }

  /** Show, hide or swap every subscription model at once. */
  async function modelsVisibility(payload: any): Promise<Record<string, unknown>> {
    const mode = String(payload?.mode ?? "")
    if (mode !== "all" && mode !== "none" && mode !== "invert") {
      throw new Error('mode must be one of "all", "none" or "invert"')
    }
    const cfg = readConfig()
    const known = (cfg.knownModels ?? []).map(String)
    const hidden = new Set((cfg.hiddenModels ?? []).map(String))
    const next: string[] = []
    for (const id of known) {
      const wasHidden = hidden.has(id)
      if (mode === "all" ? false : mode === "none" ? true : !wasHidden) next.push(id)
    }
    await control.updateConfig({ hiddenModels: next })
    await control.refreshModels()
    return { mode, hiddenModels: next.length, visibleModels: known.length - next.length, ...(await state()) }
  }

  /** Store one credential literal under its reference. */
  async function keySet(payload: any): Promise<Record<string, unknown>> {
    const ref = String(payload?.ref ?? "").trim()
    const value = String(payload?.value ?? "").trim()
    if (ref.length === 0) throw new Error("storing a key needs the credential reference it belongs to")
    if (value.length === 0) throw new Error("the key is empty")
    await control.setCredential(ref, value)
    return { ref, stored: true, ...(await state()) }
  }

  /** Verify one account by making a single tiny real request. */
  async function keyTest(payload: any): Promise<Record<string, unknown>> {
    const typed = String(payload?.value ?? "").trim()
    const ref = String(payload?.ref ?? "").trim()
    const cfg = readConfig()
    const accounts = await control.accounts()
    const account = ref === "" ? undefined : accounts.find((entry) => String(entry.apiKeyEnv) === ref)
    const baseURL = String(account?.baseURL ?? "") || String(cfg.baseURL ?? "")
    const label = String(account?.key ?? (typed.length > 0 ? "(typed key)" : ref))
    let key = typed
    if (key.length === 0) {
      if (ref.length === 0) throw new Error("testing a key needs a `value` or the `ref` of a stored account")
      key = await control.readCredential(ref)
      if (key === "") throw new Error(`no key is stored at ${ref}`)
    }
    const model = (cfg.knownModels ?? [])[0] ?? "cline-pass/glm-5.3-flash"
    const result = await engine.testAccount({ key, baseURL, model })
    return {
      ok: result.authorized === true,
      label,
      ms: Number(result.ms ?? 0),
      error: firstLine(result.error, 240),
    }
  }

  /** Add or update one account, optionally storing its key in the same step. */
  async function accountAdd(payload: any): Promise<Record<string, unknown>> {
    const name = String(payload?.name ?? "").trim()
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error("the account name may use letters, digits, dot, dash and underscore only")
    }
    const cfg = readConfig()
    const accounts = { ...(cfg.accounts ?? {}) }
    // Materialize the implicit default account before the first explicit one
    // replaces it, so a top-level key is never silently orphaned.
    if (Object.keys(accounts).length === 0) {
      accounts.default = {
        displayName: String(cfg.displayName ?? "default"),
        apiKeyEnv: String(cfg.apiKeyEnv ?? ""),
        enabled: true,
        baseURL: "",
      }
    }
    const profile = accountProfileFor(name, payload, accounts, cfg.apiKeyEnv)
    accounts[name] = profile
    await control.updateConfig({ accounts })
    const value = String(payload?.key ?? "").trim()
    if (value.length > 0) await control.setCredential(profile.apiKeyEnv, value)
    return { name, apiKeyEnv: profile.apiKeyEnv, keyStored: value.length > 0, ...(await state()) }
  }

  /** Remove one account; its stored credential is left in place. */
  async function accountRemove(payload: any): Promise<Record<string, unknown>> {
    const name = String(payload?.name ?? "").trim()
    const cfg = readConfig()
    const accounts = { ...(cfg.accounts ?? {}) }
    if (accounts[name] === undefined) throw new Error(`no account named ${JSON.stringify(name)}`)
    delete accounts[name]
    const activeAccount = String(cfg.activeAccount ?? "") === name ? "" : cfg.activeAccount
    // The removal is named explicitly: a recursive patch that merely omits the
    // key would merge the account straight back.
    await control.updateConfig({ accounts, activeAccount }, [["accounts", name]])
    return { removed: name, ...(await state()) }
  }

  /** Switch the pool between a manual account and round-robin. */
  async function accountMode(payload: any): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {}
    if (payload?.mode !== undefined) patch.accountMode = payload.mode === "roundrobin" ? "roundrobin" : "single"
    if (payload?.active !== undefined) patch.activeAccount = String(payload.active ?? "").trim()
    if (Object.keys(patch).length === 0) throw new Error("switching the account mode needs `mode` or `active`")
    await control.updateConfig(patch)
    return await state()
  }

  /** Take one account in or out of the pool. */
  async function accountEnable(payload: any): Promise<Record<string, unknown>> {
    const name = String(payload?.name ?? "").trim()
    const enabled = payload?.enabled !== false
    const cfg = readConfig()
    const accounts = { ...(cfg.accounts ?? {}) }
    if (accounts[name] === undefined && Object.keys(accounts).length === 0 && name === "default") {
      accounts.default = {
        displayName: String(cfg.displayName ?? "default"),
        apiKeyEnv: String(cfg.apiKeyEnv ?? ""),
        enabled: true,
        baseURL: "",
      }
    }
    if (accounts[name] === undefined) throw new Error(`no account named ${JSON.stringify(name)}`)
    accounts[name] = { ...accounts[name], enabled }
    await control.updateConfig({ accounts })
    return { name, enabled, ...(await state()) }
  }

  /** Persist one model's pin. Omitted fields keep their stored value. */
  async function modelPin(payload: any): Promise<Record<string, unknown>> {
    const model = modelOf(payload)
    const cfg = readConfig()
    const current = cfg.perModel?.[model] ?? { upstreams: [], exclude: [], pinMode: "strict", sort: "" }
    const next: PinProfile = {
      upstreams: Array.isArray(payload?.upstreams)
        ? payload.upstreams.map(String).filter((value: string) => value.length > 0)
        : (current.upstreams ?? []).map(String),
      exclude: Array.isArray(payload?.exclude)
        ? payload.exclude.map(String).filter((value: string) => value.length > 0)
        : (current.exclude ?? []).map(String),
      pinMode:
        payload?.pinMode === "preferred" || payload?.pinMode === "strict"
          ? payload.pinMode
          : current.pinMode === "preferred"
            ? "preferred"
            : "strict",
      sort:
        payload?.sort === undefined
          ? String(current.sort ?? "")
          : payload.sort === "none" || payload.sort === ""
            ? ""
            : String(payload.sort),
    }
    await control.updateConfig({ perModel: { ...(cfg.perModel ?? {}), [model]: next } })
    return { model, pin: next, ...(await state()) }
  }

  /** Discover one model's pipeline and channel list (one tiny real request). */
  async function modelProbe(payload: any): Promise<Record<string, unknown>> {
    const model = modelOf(payload)
    const result = await engine.probe(model)
    return { model, result: { ...result, error: firstLine(result.error, 300) } }
  }

  /** Test every known channel of one model and record the verdicts. */
  async function modelValidate(payload: any): Promise<Record<string, unknown>> {
    const model = modelOf(payload)
    const meta = store.metaOf(model)
    if (!Array.isArray(meta.upstreams) || meta.upstreams.length === 0) {
      throw new Error("no known channels yet: probe this model first")
    }
    const outcome = await engine.validate(model)
    return {
      model,
      summary: outcome.summary,
      results: outcome.results.map((result) => ({
        upstream: String(result.upstream),
        status: String(result.status),
        ms: Number(result.ms ?? 0),
        note: firstLine(result.note, 160),
      })),
      ...(await state()),
    }
  }

  /** Try one pin without persisting it, and report what actually served it. */
  async function modelTest(payload: any): Promise<Record<string, unknown>> {
    const model = modelOf(payload)
    const result = await engine.test(model, {
      upstreams: Array.isArray(payload?.upstreams) ? payload.upstreams.map(String) : undefined,
      exclude: Array.isArray(payload?.exclude) ? payload.exclude.map(String) : undefined,
    })
    return {
      model,
      ok: result.ok === true,
      error: firstLine(result.error, 300),
      actual: String(result.actual ?? ""),
      actualName: String(result.actualName ?? ""),
      targets: (result.targets ?? []).map(String),
      excluded: (result.excluded ?? []).map(String),
      adopted: result.adopted === true,
      adherence: String(result.adherence ?? ""),
      warnings: (result.warnings ?? []).map((warning) => firstLine(warning, 200)),
      plan: firstLine(result.plan, 300),
      pipeline: String(result.pipeline ?? ""),
      ms: Number(result.ms ?? 0),
      content: String(result.content ?? "").slice(0, 120),
      trace: (result.trace ?? []).map((entry) => ({
        upstream: String(entry.upstream ?? "(auto)"),
        status: Number(entry.status ?? 0),
        ms: Number(entry.ms ?? 0),
        note: firstLine(entry.note, 160),
      })),
    }
  }

  /** Rescan the official subscription list and adopt newly published models. */
  async function modelsRefresh(): Promise<Record<string, unknown>> {
    const scan = await control.refreshCatalog()
    return { added: scan.added.map(String), sources: (scan.sources ?? []).map(String), ...(await state()) }
  }

  /** Drop one model's pin and return it to automatic routing. */
  async function modelReset(payload: any): Promise<Record<string, unknown>> {
    return await modelPin({ model: modelOf(payload), upstreams: [], exclude: [], sort: "none", pinMode: "preferred" })
  }

  /** The live request history, newest first. */
  async function history(payload: any): Promise<Record<string, unknown>> {
    const limit = Number.isSafeInteger(payload?.limit) && payload.limit > 0 ? Math.min(payload.limit, 100) : 25
    return {
      total: store.historySize(),
      entries: store.readHistory(limit, String(payload?.model ?? "")).map((entry: HistoryEntry) => ({
        ts: Number(entry.ts ?? 0),
        model: String(entry.model ?? ""),
        provider: String(entry.provider ?? ""),
        account: String(entry.account ?? ""),
        ms: Number(entry.ms ?? 0),
        ttfb: Number(entry.ttfb ?? 0),
        ttft: Number(entry.ttft ?? 0),
        usageReported: entry.usage !== null && entry.usage !== undefined,
        usage: {
          inputTokens: Number(entry.usage?.inputTokens ?? 0),
          outputTokens: Number(entry.usage?.outputTokens ?? 0),
          cacheReadTokens: Number(entry.usage?.cacheReadTokens ?? 0),
          reasoningTokens: Number(entry.usage?.reasoningTokens ?? 0),
        },
        effort: String(entry.effort ?? ""),
        stream: entry.stream === true,
        adherence: String(entry.adherence ?? ""),
        attempts: Array.isArray(entry.attempts) ? entry.attempts.map(String) : [],
        warnings: Array.isArray(entry.warnings) ? entry.warnings.map((warning) => firstLine(warning, 200)) : [],
        error: firstLine(entry.error, 200),
        code: String(entry.code ?? ""),
      })),
    }
  }

  /** Whether the tools are registered; the value takes effect next start. */
  async function toolsExpose(payload: any): Promise<Record<string, unknown>> {
    if (typeof payload?.value !== "boolean") throw new Error("this action needs a boolean `value`")
    await control.updateConfig({ exposeTools: payload.value })
    return { restartRequired: true, ...(await state()) }
  }

  return {
    state,
    usage,
    "usage.daily": usageDaily,
    "key.set": keySet,
    "key.test": keyTest,
    "account.add": accountAdd,
    "account.remove": accountRemove,
    "account.mode": accountMode,
    "account.enable": accountEnable,
    "model.pin": modelPin,
    "model.visibility": modelVisibility,
    "models.visibility": modelsVisibility,
    "model.probe": modelProbe,
    "model.validate": modelValidate,
    "model.test": modelTest,
    "model.reset": modelReset,
    "models.refresh": modelsRefresh,
    "tools.expose": toolsExpose,
    history,
  }
}

/** Mask a key for display in the dashboard. */
export { maskKey }

export { dashboardHTML } from "./dashboard-page.js"
