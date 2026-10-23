/**
 * Shared types for the opencode Cline Pass plugin.
 *
 * The vocabulary mirrors the dsh-cline-pass provider this implementation is
 * ported from, so the behavior documentation applies one-to-one.
 */

/** What one account is: a credential reference plus routing participation. */
export interface AccountProfile {
  displayName: string
  /** Credential reference: an environment variable name or a local store key. */
  apiKeyEnv: string
  enabled: boolean
  /** Per-account gateway address; an empty string uses the route-wide baseURL. */
  baseURL: string
}

/** One model's catalog override, merged over the published metadata. */
export interface ModelProfile {
  name: string
  contextWindow: number
  /** This model's output ceiling. 0 means "not set". */
  maxTokens: number
  reasoning?: boolean
  input: string[]
}

/** One model's upstream pin. */
export interface PinProfile {
  upstreams: string[]
  exclude: string[]
  pinMode: string
  sort: string
  /**
   * Capability requirements compiled into `providerOptions.gateway.has`.
   *
   * This is not cosmetic. On a VMC-fixed id the planner ignores `only` unless a
   * positive capability condition travels with it; the gate is what makes the
   * allow-list reach the router. Empty means "inherit `pinCapabilities`".
   */
  capabilities: string[]
}

/** Validated plugin configuration. */
export interface PluginConfig {
  provider: string
  displayName: string
  baseURL: string
  apiKeyEnv: string
  accounts: Record<string, AccountProfile>
  accountMode: "single" | "roundrobin"
  activeAccount: string
  knownModels: string[]
  hiddenModels: string[]
  /**
   * Local model id to the id the gateway actually wants.
   *
   * A `cline-pass/*` id can resolve to a VMC that defaults to one private
   * channel; its full channel set is reachable through the capability gate, so
   * an alias is no longer needed to pin it. What an alias still buys is the open
   * pool (`vendor/model`), a different — per-token billed — route with its own
   * channel list and pricing.
   */
  modelAliases: Record<string, string>
  models: Record<string, ModelProfile>
  perModel: Record<string, PinProfile>
  reasoningModels: boolean
  defaultContextWindow: number
  defaultMaxTokens: number
  streamIdleTimeoutMs: number
  /** Streams one account may keep open at once. 0 lifts the cap. */
  maxConcurrentRequests: number
  /** Whether the `cline_pass_*` management tools are registered. */
  exposeTools: boolean
  exposeCatalog: boolean
  /** Skip the startup catalog scan (air-gapped installs and tests). */
  skipCatalogScan: boolean
  historyLimit: number
  /** Which pin spellings a request carries. */
  pinSpelling: string
  /**
   * Capability requirements sent with every planner pin.
   *
   * The planner drops `only` on VMC-fixed ids unless at least one positive
   * capability condition is present, so this is the switch that makes those pins
   * real. An empty list disables the gate (and with it, pinning on such ids).
   */
  pinCapabilities: string[]
  /** Local gateway bind address. Loopback only by default. */
  serverHost: string
  /** Local gateway port; 0 asks the OS for a free port. */
  serverPort: number
  /** Serve the management dashboard. */
  dashboard: boolean
}

/** One Cline Pass model's published metadata. */
export interface ModelCatalogEntry {
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: string[]
}

/** A model descriptor as advertised to the host. */
export interface ResolvedModel {
  provider: string
  id: string
  name: string
  inputModalities: string[]
  context: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: boolean
}

/** What one probe learned about a model's routing. */
export interface UpstreamDetail {
  slug: string
  name: string
  endpoints: number
  context: number
  uptime: number
}

/** One upstream availability verdict. */
export interface UpstreamVerdict {
  status: string
  note: string
  ms: number
  checkedAt: number
}

export interface ModelMeta {
  ok?: boolean
  pipeline?: "planner" | "direct" | null
  pinnable?: boolean
  /**
   * The VMC the gateway routed through, when it used one.
   *
   * A virtual model config fixes the provider list before the router ever looks
   * at a pin, so its presence is the difference between "one channel today" and
   * "one channel by construction".
   */
  virtualModel?: string | null
  /** True when the route answered an impossible pin: pins cannot apply. */
  pinInert?: boolean
  /**
   * True when the route is a VMC and only a capability-gated pin reaches the
   * router — i.e. the channel list came from a `has`-qualified probe and a pin
   * written without `has` would be dropped.
   */
  capabilityGated?: boolean
  canonicalSlug?: string | null
  openrouterSlug?: string | null
  upstreams?: string[]
  channels?: Partial<Record<"planner" | "direct", string[]>>
  upstreamDetail?: Record<string, UpstreamDetail>
  upstreamStatus?: Record<string, UpstreamVerdict>
  availableProviders?: string[]
  tier0?: string[]
  lastProvider?: string | null
  lastMs?: number
  probedAt?: number
  validatedAt?: number
  staleAt?: number
  lastError?: string
}

/** One routing attempt: a channel preference compiled for the wire. */
export interface Attempt {
  upstream: string | null
  strict: boolean
  sort: string | null
  orderRest: string[]
  excludeList: string[]
  spelling?: string
  /** Capability conditions written as `has` next to a planner pin. */
  capabilities?: string[]
}

/** A pin configuration as stored (plus the route-wide spelling policy). */
export interface PinConfig {
  upstreams?: string[]
  exclude?: string[]
  pinMode?: string
  sort?: string | null
  spelling?: string
  capabilities?: string[]
}

/** Routing facts read back from one gateway response. */
export interface Routing {
  content: string | null
  toolCalls: unknown[]
  usage: unknown
  pipeline: "planner" | "direct" | null
  canonicalSlug: string | null
  finalProvider: string | null
  finalProviderName: string | null
  fallbacks: string[]
  plan: string
  /** The VMC that fixed this route, when the gateway used one. */
  virtualModel: string | null
}

export type Adherence = "adopted" | "fallback" | "not-adopted" | "violated" | "unresolved"

/** Token counts, disjoint as the host expects. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

/** One request-history row. */
export interface HistoryEntry {
  ts: number
  model: string
  provider: string | null
  canonical: string | null
  account: string | null
  ms: number
  ttfb?: number
  ttft?: number
  stream: boolean
  effort?: string
  usage?: Usage | null
  error?: string | null
  code?: string
  attempts?: string[]
  adherence?: Adherence | string
  warnings?: string[]
}

/** One row of a candidate chain's trace. */
export interface TraceRow {
  upstream: string
  status: number
  ms: number
  note: string
}

/** One resolved account, ready to serve a request. */
export interface ResolvedAccount {
  name: string
  key: string
  baseURL: string
}

/** An account as shown to a human, never including the key. */
export interface AccountView {
  key: string
  displayName: string
  apiKeyEnv: string
  enabled: boolean
  baseURL: string
  keyConfigured: boolean
  keyHint: string
}

/** An account plus its resolved key, for internal management calls. */
export interface UsageAccount {
  name: string
  displayName: string
  key: string
  keyConfigured: boolean
  baseURL: string
}

/** The official quota reading for one account. */
export interface UsageLimit {
  type: string
  percentUsed: number
  resetsAt: string
}

export interface UsageReading {
  account: string
  displayName: string
  ok: boolean
  limits: UsageLimit[]
  error: string
}

/** One day/model row from the gateway's daily usage aggregation. */
export interface DailyUsageRow {
  date: string
  model: string
  tokens: number
  costUsd: number
}
