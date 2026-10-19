/**
 * The shared control surface behind the provider registration, the
 * `cline_pass_*` tools, and the dashboard. One surface keeps the three faces
 * from ever disagreeing about what is configured.
 */
import { catalogEntry, discoveredContext, providerModelKey, resolveModelMetadata, toOpencodeModelConfig } from "./catalog.js"
import type { ConfigStore } from "./config.js"
import type { Engine } from "./engine.js"
import type { Logger } from "./log.js"
import type { AccountPool } from "./pool.js"
import type { ObservationStore } from "./store.js"
import type { AccountView, ModelProfile, PluginConfig, ResolvedModel, UsageAccount } from "./types.js"

export interface Connection {
  baseURL: string
  displayName: string
  models: ResolvedModel[]
  defaultContextWindow: number
  maxTokens: number
  reasoningModels: boolean
  streamIdleTimeoutMs: number
  maxConcurrentRequests: number
}

export interface Control {
  providerName: string
  displayName: string
  configPath: string
  configError?: string
  settingsAvailable(): boolean
  readConfig(): PluginConfig
  updateConfig(patch: Record<string, unknown>, removals?: string[][]): Promise<void>
  accounts(): Array<AccountView & { declared: boolean }>
  accountsWithKeys(): Promise<Array<AccountView & { declared: boolean }>>
  readCredential(ref: string): Promise<string>
  setCredential(ref: string, value: string): Promise<void>
  effectiveAccount(): Promise<string>
  usageAccounts(): Promise<UsageAccount[]>
  refreshCatalog(): Promise<{ added: string[]; models: string[]; sources: string[] }>
  modelIds(): string[]
  connection(): Connection
  pinFor(model: string): PluginConfig["perModel"][string] & { spelling: string }
  opencodeModels(): Record<string, Record<string, unknown>>
  /** v2 can re-run provider transforms after a visibility/catalog change. */
  setModelRefresher(refresher: (() => Promise<void>) | undefined): void
  /** Ask the host to refresh the provider model inventory, when supported. */
  refreshModels(): Promise<void>
}

export interface ControlOptions {
  config: ConfigStore
  pool: AccountPool
  store: ObservationStore
  engine: Engine
  logger: Logger
}

/** Create the shared control surface. */
export function createControl(options: ControlOptions): Control {
  const { config, pool, store, engine, logger } = options
  const readConfig = (): PluginConfig => config.read()
  let modelRefresher: (() => Promise<void>) | undefined

  const modelIds = (): string[] => {
    const cfg = readConfig()
    const hidden = new Set((cfg.hiddenModels ?? []).map(String))
    const ids = (cfg.knownModels ?? []).map(String)
    if (cfg.exposeCatalog === true) {
      for (const id of store.catalog().ids ?? []) if (!ids.includes(id)) ids.push(String(id))
    }
    return ids.filter((id) => !hidden.has(id))
  }

  const resolveModel = (id: string): ResolvedModel => {
    const cfg = readConfig()
    const entry = catalogEntry(id) ?? {}
    const override: Partial<ModelProfile> = Object.hasOwn(cfg.models ?? {}, id) ? cfg.models[id]! : {}
    const discovered = Object.hasOwn(store.catalog().models ?? {}, id) ? store.catalog().models[id]! : {}
    const meta = store.metaOf(id)
    const measured = discoveredContext(meta)
    const resolved = resolveModelMetadata(
      cfg.provider,
      id,
      override,
      {
        contextWindow: cfg.defaultContextWindow ?? 128000,
        maxTokens: cfg.defaultMaxTokens ?? 64000,
        reasoning: cfg.reasoningModels !== false,
      },
      { ...entry, ...discovered },
    )
    // A probe that saw this model's real endpoints overrides the published
    // window: it is measured, not documented.
    return measured === undefined
      ? resolved
      : { ...resolved, context: { contextWindow: Math.max(measured, resolved.context.contextWindow) } }
  }

  const connection = (): Connection => {
    const cfg = readConfig()
    return {
      baseURL: cfg.baseURL,
      displayName: cfg.displayName,
      models: modelIds().map(resolveModel),
      defaultContextWindow: cfg.defaultContextWindow,
      maxTokens: cfg.defaultMaxTokens,
      reasoningModels: cfg.reasoningModels,
      streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
      maxConcurrentRequests: cfg.maxConcurrentRequests,
    }
  }

  const updateConfig = async (patch: Record<string, unknown>, removals: string[][] = []): Promise<void> => {
    const next = await config.update(patch, removals)
    // A history cap change must reach the running store, not just the file.
    store.setHistoryLimit(next.historyLimit)
  }

  return {
    providerName: readConfig().provider,
    displayName: readConfig().displayName,
    configPath: config.configPath,
    ...(config.loadError === undefined ? {} : { configError: config.loadError }),
    settingsAvailable: () => true,
    readConfig,
    updateConfig,
    accounts: () => pool.accounts(),
    accountsWithKeys: () => pool.accountsWithKeys(),
    readCredential: async (ref) => (await config.resolveCredential(ref)) ?? "",
    setCredential: async (ref, value) => {
      await config.setCredential(ref, value)
    },
    effectiveAccount: () => pool.effectiveAccount(),
    usageAccounts: () => pool.usageAccounts(),
    refreshCatalog: async () => {
      const scan = await engine.officialModels({})
      const cfg = readConfig()
      const currentModels = (cfg.knownModels ?? []).map(String)
      const added = scan.models.filter((id) => !currentModels.includes(id))
      if (added.length > 0) await updateConfig({ knownModels: [...currentModels, ...added] })
      const gatewayIds =
        cfg.exposeCatalog === true ? await engine.gatewayCatalog({}).catch(() => []) : []
      store.setCatalog({
        ids: [...new Set([...scan.models, ...gatewayIds])],
        models: scan.catalog as Record<string, Record<string, unknown>>,
        sources: scan.sources,
      })
      if (modelRefresher !== undefined) {
        try {
          await modelRefresher()
        } catch (error) {
          logger.warn("[cline-pass] provider model refresh failed: %s", error instanceof Error ? error.message : String(error))
        }
      }
      return { added, models: scan.models, sources: scan.sources }
    },
    modelIds,
    connection,
    pinFor: (model) => {
      const cfg = readConfig()
      const stored = Object.hasOwn(cfg.perModel ?? {}, model)
        ? cfg.perModel[model]!
        : { upstreams: [], exclude: [], pinMode: "strict", sort: "" }
      return { ...stored, spelling: cfg.pinSpelling }
    },
    opencodeModels: () => {
      const models: Record<string, Record<string, unknown>> = {}
      for (const id of modelIds()) models[providerModelKey(id)] = toOpencodeModelConfig(resolveModel(id))
      return models
    },
    setModelRefresher: (refresher) => {
      modelRefresher = refresher
    },
    refreshModels: async () => {
      if (modelRefresher === undefined) return
      try {
        await modelRefresher()
      } catch (error) {
        logger.warn("[cline-pass] provider model refresh failed: %s", error instanceof Error ? error.message : String(error))
      }
    },
  }
}
