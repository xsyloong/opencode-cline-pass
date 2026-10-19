/**
 * Configuration and credential persistence.
 *
 * dsh kept configuration in its settings service and keys in its credential
 * store. opencode has neither seam for plugins, so this module owns both:
 *
 * - `~/.config/opencode/cline-pass.json` (global; `XDG_CONFIG_HOME` respected)
 * - `<project>/.opencode/cline-pass.json` (project override)
 * - `cline-pass.credentials.json` next to each config file, mode 0600
 *
 * Configuration files never contain keys. Credentials resolve stored-first,
 * then from the environment, so exporting `CLINE_PASS_API_KEY` still works on a
 * fresh install while a key saved through the dashboard takes precedence.
 */
import { readFileSync, statSync } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { ClinePassError } from "./errors.js"
import { DEFAULT_HISTORY_LIMIT } from "./store.js"
import type { AccountProfile, ModelProfile, PinProfile, PluginConfig } from "./types.js"

/** Cline Pass subscription models current at release time; refreshed on demand. */
export const DEFAULT_MODELS = [
  "cline-pass/glm-5.3-flash",
  "cline-pass/kimi-k3",
  "cline-pass/deepseek-v4-flash",
  "cline-pass/deepseek-v4.1-flash",
  "cline-pass/qwen3.8-max",
  "cline-pass/minimax-m3",
  "cline-pass/glm-5.3",
  "cline-pass/glm-5.2",
  "cline-pass/deepseek-v4-pro",
  "cline-pass/mimo-v2.5-pro",
  "cline-pass/mimo-v2.5",
  "cline-pass/kimi-k2.6",
  "cline-pass/qwen3.7-plus",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/qwen3.7-max",
]

export const DEFAULT_PROVIDER = "cline-pass"
export const DEFAULT_SETTINGS_NS = "cline-pass"
export const DEFAULT_API_KEY_ENV = "CLINE_PASS_API_KEY"
export const DEFAULT_BASE_URL = "https://api.cline.bot/api/v1"
export const DEFAULT_CONTEXT_WINDOW = 128000
export const DEFAULT_MAX_TOKENS = 64000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 16
export const CONFIG_FILE = "cline-pass.json"
export const CREDENTIALS_FILE = "cline-pass.credentials.json"

/** The route-wide defaults a fresh install runs on. */
export function defaultConfig(): PluginConfig {
  return {
    provider: DEFAULT_PROVIDER,
    displayName: "Cline Pass",
    baseURL: DEFAULT_BASE_URL,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    accounts: {},
    accountMode: "single",
    activeAccount: "",
    knownModels: [...DEFAULT_MODELS],
    hiddenModels: [],
    models: {},
    perModel: {},
    reasoningModels: true,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
    // opencode's primary management surface is the tool list, so the tools are
    // on by default here. Set false to keep only the provider + dashboard.
    exposeTools: true,
    exposeCatalog: false,
    skipCatalogScan: false,
    historyLimit: DEFAULT_HISTORY_LIMIT,
    pinSpelling: "both",
    serverHost: "127.0.0.1",
    serverPort: 0,
    dashboard: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Recursive merge: plain objects merge, arrays and primitives replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue
    const current = next[key]
    next[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value
  }
  return next as T
}

/** Delete one key path from an object tree, returning a new tree. */
export function unsetPath(source: unknown, path: string[]): unknown {
  if (!isRecord(source) || path.length === 0) return source
  const [head, ...rest] = path
  const next: Record<string, unknown> = { ...source }
  if (head === undefined || UNSAFE_KEYS.has(head)) return next
  if (rest.length === 0) delete next[head]
  else if (Object.hasOwn(next, head)) next[head] = unsetPath(next[head], rest)
  return next
}

/** Apply a patch plus explicit removals, with the settings service's semantics. */
export function applyPatch(
  config: PluginConfig,
  patch: Record<string, unknown>,
  removals: string[][] = [],
): PluginConfig {
  let next: unknown = config
  for (const path of removals) next = unsetPath(next, path)
  return deepMerge(next as PluginConfig, patch)
}

function normalizeAccount(raw: unknown): AccountProfile {
  const value = isRecord(raw) ? raw : {}
  return {
    displayName: String(value.displayName ?? ""),
    apiKeyEnv: String(value.apiKeyEnv ?? ""),
    enabled: value.enabled !== false,
    baseURL: String(value.baseURL ?? "").trim(),
  }
}

function normalizeModel(raw: unknown): ModelProfile {
  const value = isRecord(raw) ? raw : {}
  return {
    name: String(value.name ?? ""),
    contextWindow: Number.isFinite(Number(value.contextWindow)) ? Number(value.contextWindow) : 0,
    maxTokens: Number.isFinite(Number(value.maxTokens)) ? Number(value.maxTokens) : 0,
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    input: Array.isArray(value.input) ? value.input.map(String) : [],
  }
}

function normalizePin(raw: unknown): PinProfile {
  const value = isRecord(raw) ? raw : {}
  return {
    upstreams: Array.isArray(value.upstreams) ? value.upstreams.map(String) : [],
    exclude: Array.isArray(value.exclude) ? value.exclude.map(String) : [],
    pinMode: value.pinMode === "preferred" ? "preferred" : "strict",
    sort: typeof value.sort === "string" ? value.sort : "",
  }
}

function positive(value: unknown, fallback: number, allowZero = false): number {
  const next = Number(value)
  if (!Number.isFinite(next)) return fallback
  if (next < 0) return fallback
  if (next === 0 && !allowZero) return fallback
  return Math.floor(next)
}

/** Coerce a loaded object into a complete, valid configuration. */
export function normalizeConfig(raw: unknown): PluginConfig {
  const value = isRecord(raw) ? raw : {}
  const defaults = defaultConfig()
  const accounts: Record<string, AccountProfile> = {}
  if (isRecord(value.accounts)) {
    for (const [key, entry] of Object.entries(value.accounts)) {
      if (key.length === 0 || UNSAFE_KEYS.has(key)) continue
      accounts[key] = normalizeAccount(entry)
    }
  }
  const models: Record<string, ModelProfile> = {}
  if (isRecord(value.models)) {
    for (const [key, entry] of Object.entries(value.models)) {
      if (UNSAFE_KEYS.has(key)) continue
      models[key] = normalizeModel(entry)
    }
  }
  const perModel: Record<string, PinProfile> = {}
  if (isRecord(value.perModel)) {
    for (const [key, entry] of Object.entries(value.perModel)) {
      if (UNSAFE_KEYS.has(key)) continue
      perModel[key] = normalizePin(entry)
    }
  }
  const known = Array.isArray(value.knownModels)
    ? value.knownModels.map(String).filter((id) => id.length > 0 && !UNSAFE_KEYS.has(id))
    : defaults.knownModels
  const baseURL = String(value.baseURL ?? defaults.baseURL).trim().replace(/\/+$/, "") || defaults.baseURL
  return {
    provider: String(value.provider ?? "").trim() || defaults.provider,
    displayName: String(value.displayName ?? defaults.displayName).trim() || defaults.displayName,
    baseURL,
    apiKeyEnv: String(value.apiKeyEnv ?? "").trim() || defaults.apiKeyEnv,
    accounts,
    accountMode: value.accountMode === "roundrobin" ? "roundrobin" : "single",
    activeAccount: String(value.activeAccount ?? ""),
    knownModels: known.length > 0 ? [...new Set(known)] : defaults.knownModels,
    hiddenModels: Array.isArray(value.hiddenModels) ? [...new Set(value.hiddenModels.map(String))] : [],
    models,
    perModel,
    reasoningModels: value.reasoningModels !== false,
    defaultContextWindow: positive(value.defaultContextWindow, defaults.defaultContextWindow),
    defaultMaxTokens: positive(value.defaultMaxTokens, defaults.defaultMaxTokens),
    streamIdleTimeoutMs: Math.max(1000, positive(value.streamIdleTimeoutMs, defaults.streamIdleTimeoutMs)),
    // 0 is meaningful: it lifts the per-account stream cap.
    maxConcurrentRequests: positive(value.maxConcurrentRequests, defaults.maxConcurrentRequests, true),
    exposeTools: value.exposeTools !== false,
    exposeCatalog: value.exposeCatalog === true,
    skipCatalogScan: value.skipCatalogScan === true,
    historyLimit: positive(value.historyLimit, defaults.historyLimit),
    pinSpelling: value.pinSpelling === "detected" ? "detected" : "both",
    serverHost: String(value.serverHost ?? defaults.serverHost).trim() || defaults.serverHost,
    serverPort: Math.min(65535, positive(value.serverPort, defaults.serverPort, true)),
    dashboard: value.dashboard !== false,
  }
}

export interface ConfigPaths {
  globalDir: string
  globalConfig: string
  globalCredentials: string
  projectDir: string
  projectConfig: string
  projectCredentials: string
}

/** Resolve every path this plugin owns for one project directory. */
export function configPaths(directory: string, env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const root = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config")
  const globalDir = join(root, "opencode")
  const projectDir = join(resolve(directory), ".opencode")
  return {
    globalDir,
    globalConfig: join(globalDir, CONFIG_FILE),
    globalCredentials: join(globalDir, CREDENTIALS_FILE),
    projectDir,
    projectConfig: join(projectDir, CONFIG_FILE),
    projectCredentials: join(projectDir, CREDENTIALS_FILE),
  }
}

async function readJSON(path: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ClinePassError(
      `${path} is not valid JSON: ${(error as Error).message}`,
      "INVALID_CONFIG",
      { cause: error },
    )
  }
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => {
    /* Windows and some filesystems do not implement POSIX modes. */
  })
}

export interface ConfigStoreOptions {
  directory: string
  env?: NodeJS.ProcessEnv
}

/**
 * The plugin's live configuration plus its credential store.
 *
 * Reads are synchronous (`read()`), writes are awaited and persisted. Consumers
 * must treat the object returned by `read()` as immutable; every write replaces
 * it.
 */
export class ConfigStore {
  readonly paths: ConfigPaths
  private current: PluginConfig
  private keys: Record<string, string>
  private readonly env: NodeJS.ProcessEnv
  private readonly loadedFromProject: boolean
  private readonly projectCredentialsExist: boolean
  /** Serializes writes so a startup scan cannot overwrite a concurrent tool edit. */
  private writes: Promise<unknown> = Promise.resolve()
  /** Last mtime read from `configPath`, so another client's pin is noticed. */
  private diskMtime = 0
  /** The first load error, so the dashboard can report a broken file. */
  readonly loadError?: string

  private constructor(options: {
    paths: ConfigPaths
    config: PluginConfig
    keys: Record<string, string>
    env: NodeJS.ProcessEnv
    loadedFromProject: boolean
    projectCredentialsExist: boolean
    loadError?: string
  }) {
    this.paths = options.paths
    this.current = options.config
    this.keys = options.keys
    this.env = options.env
    this.loadedFromProject = options.loadedFromProject
    this.projectCredentialsExist = options.projectCredentialsExist
    this.loadError = options.loadError
  }

  /** Load global configuration, then overlay the project file. */
  static async load(options: ConfigStoreOptions): Promise<ConfigStore> {
    const env = options.env ?? process.env
    const paths = configPaths(options.directory, env)
    let raw: unknown = {}
    let loadError: string | undefined
    let loadedFromProject = false
    try {
      const global = await readJSON(paths.globalConfig)
      raw = global ?? {}
    } catch (error) {
      loadError = (error as Error).message
    }
    try {
      const project = await readJSON(paths.projectConfig)
      if (project !== undefined) {
        loadedFromProject = true
        raw = deepMerge(raw, project)
      }
    } catch (error) {
      loadError = loadError ?? (error as Error).message
    }
    let keys: Record<string, string> = {}
    let projectCredentialsExist = false
    try {
      const globalKeys = await readJSON(paths.globalCredentials)
      if (isRecord(globalKeys)) keys = { ...coerceKeys(globalKeys) }
      const projectKeys = await readJSON(paths.projectCredentials)
      if (projectKeys !== undefined) {
        projectCredentialsExist = true
        if (isRecord(projectKeys)) keys = { ...keys, ...coerceKeys(projectKeys) }
      }
    } catch (error) {
      loadError = loadError ?? (error as Error).message
    }
    const normalized = normalizeConfig(raw)
    if (env.CLINE_PASS_SKIP_CATALOG === "1") normalized.skipCatalogScan = true
    return new ConfigStore({
      paths,
      config: normalized,
      keys,
      env,
      loadedFromProject,
      projectCredentialsExist,
      loadError,
    })
  }

  /**
   * Pick up a configuration written by another opencode client.
   *
   * Two clients (a TUI and a desktop app, or two opencode processes) share this
   * file. Without this, the second client keeps its startup snapshot and a pin
   * saved in the first is invisible to it until a full restart. `statSync` per
   * read is cheap; the file is parsed only when its mtime changes.
   */
  private refreshFromDisk(): void {
    try {
      const mtime = statSync(this.configPath).mtimeMs
      if (mtime === this.diskMtime) return
      this.diskMtime = mtime
      const raw = JSON.parse(readFileSync(this.configPath, "utf8"))
      this.current = normalizeConfig(deepMerge(this.current, raw))
      if (this.env.CLINE_PASS_SKIP_CATALOG === "1") this.current.skipCatalogScan = true
    } catch {
      /* absent, malformed or mid-write: keep the current snapshot */
    }
  }

  /** The live configuration. Treat as immutable. */
  read(): PluginConfig {
    this.refreshFromDisk()
    return this.current
  }

  /** The file this store writes configuration into. */
  get configPath(): string {
    return this.loadedFromProject ? this.paths.projectConfig : this.paths.globalConfig
  }

  /** The file this store writes credentials into. */
  get credentialsPath(): string {
    return this.projectCredentialsExist ? this.paths.projectCredentials : this.paths.globalCredentials
  }

  /** Run one write at a time, in call order. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writes.then(task, task)
    this.writes = next.catch(() => undefined)
    return next
  }

  /**
   * Merge the current file over our snapshot before writing.
   *
   * Two opencode clients can share this config (a TUI and a desktop app, or a
   * short-lived `opencode models` process). Writing a whole-file snapshot from
   * a stale client is how a pin saved in one client used to disappear when the
   * other refreshed the catalog. The on-disk document wins on conflict, while
   * the in-memory document supplies fields the file does not carry (for a
   * project override that only lists a subset).
   */
  private async currentOnDisk(): Promise<PluginConfig> {
    try {
      const disk = await readJSON(this.configPath)
      if (disk !== undefined) return normalizeConfig(deepMerge(this.current, disk))
    } catch {
      /* a malformed/absent file leaves the in-memory snapshot in charge */
    }
    return this.current
  }

  /** Apply a patch (and optional removals) in memory and on disk. */
  async update(patch: Record<string, unknown>, removals: string[][] = []): Promise<PluginConfig> {
    return await this.enqueue(async () => {
      this.current = normalizeConfig(applyPatch(await this.currentOnDisk(), patch, removals))
      await writeJSON(this.configPath, this.current)
      this.diskMtime = 0
      return this.current
    })
  }

  /** Replace the whole configuration (used by tests and advanced tooling). */
  async replace(next: unknown): Promise<PluginConfig> {
    return await this.enqueue(async () => {
      this.current = normalizeConfig(next)
      await writeJSON(this.configPath, this.current)
      this.diskMtime = 0
      return this.current
    })
  }

  /** Resolve one credential reference. Stored keys win over the environment. */
  async resolveCredential(ref: string): Promise<string | undefined> {
    const stored = Object.hasOwn(this.keys, ref) ? this.keys[ref] : undefined
    if (typeof stored === "string" && stored.trim().length > 0) return stored.trim()
    const ambient = Object.hasOwn(this.env, ref) ? this.env[ref] : undefined
    if (typeof ambient === "string" && ambient.trim().length > 0) return ambient.trim()
    return undefined
  }

  /** Re-read credentials another client may have written since our load. */
  private async refreshKeysFromDisk(): Promise<void> {
    try {
      const disk = await readJSON(this.credentialsPath)
      if (isRecord(disk)) this.keys = { ...this.keys, ...coerceKeys(disk) }
    } catch {
      /* keep the in-memory keys */
    }
  }

  /** Persist one credential literal. */
  async setCredential(ref: string, value: string): Promise<void> {
    const name = String(ref ?? "").trim()
    const secret = String(value ?? "").trim()
    if (name.length === 0) throw new Error("storing a key needs the credential reference it belongs to")
    if (name === "__proto__" || name === "constructor" || name === "prototype") {
      throw new Error(`${JSON.stringify(name)} is not a usable credential reference`)
    }
    if (secret.length === 0) throw new Error("the key is empty")
    await this.enqueue(async () => {
      await this.refreshKeysFromDisk()
      this.keys[name] = secret
      await writeJSON(this.credentialsPath, this.keys)
    })
  }

  /** Remove a stored credential; environment values are unaffected. */
  async removeCredential(ref: string): Promise<void> {
    if (!Object.hasOwn(this.keys, ref)) return
    await this.enqueue(async () => {
      await this.refreshKeysFromDisk()
      delete this.keys[ref]
      await writeJSON(this.credentialsPath, this.keys)
    })
  }

  /** A masked hint for one credential, or an empty string when unset. */
  async credentialHint(ref: string): Promise<string> {
    const value = await this.resolveCredential(ref)
    return value === undefined ? "" : maskHint(value)
  }

  /** Whether a credential resolves, without exposing it. */
  async hasCredential(ref: string): Promise<boolean> {
    return (await this.resolveCredential(ref)) !== undefined
  }
}

function coerceKeys(raw: Record<string, unknown>): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const [ref, value] of Object.entries(raw)) {
    if (UNSAFE_KEYS.has(ref)) continue
    if (typeof value === "string") keys[ref] = value
    else if (isRecord(value) && typeof value.value === "string") keys[ref] = value.value
  }
  return keys
}

function maskHint(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
