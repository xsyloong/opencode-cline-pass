/**
 * Published model metadata, plus the merge that turns a caller's overrides into
 * the descriptor the host advertises.
 *
 * Context window and output cap are provider facts, not preferences: the host
 * sizes its prompt budget against `context.contextWindow`, so an understated
 * window silently truncates history.
 */
import type { ModelCatalogEntry, ModelMeta, ModelProfile, ResolvedModel } from "./types.js"

/** Selectable reasoning efforts offered for a reasoning-capable model. */
export const REASONING_EFFORTS = [
  { id: "none", name: "None", description: "No extra thinking; fastest and cheapest." },
  { id: "minimal", name: "Minimal", description: "A bare minimum of reasoning." },
  { id: "low", name: "Low", description: "Prefer for routine or latency-sensitive work." },
  { id: "medium", name: "Medium", description: "A balanced amount of reasoning." },
  { id: "high", name: "High", description: "More thorough reasoning for multi-step work." },
  { id: "xhigh", name: "Extra high", description: "For difficult work that rewards more thinking." },
  { id: "max", name: "Max", description: "Reserve for the hardest quality-first tasks." },
] as const

/** The effort ids the gateway accepts. Anything else is refused with HTTP 400. */
export const REASONING_EFFORT_IDS = REASONING_EFFORTS.map((entry) => entry.id)

/** Published metadata for the shipped Cline Pass models. */
export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  "cline-pass/deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    input: ["text"],
  },
  // Open-pool aliases. The `cline-pass/*` ids resolve to a VMC that hardcodes
  // one provider and ignores every pin; the same weights stay pinnable through
  // the vendor slug. The name says "billed" on purpose: that route is charged
  // per token at list price, which measured ~30x the subscription rate, so the
  // cost has to be visible at the moment someone picks the model.
  "cline-pass/deepseek-v4.1-flash-1017-open": {
    name: "DeepSeek V4.1 Flash 1017 (open pool · billed)",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/glm-5.3-open": {
    name: "GLM-5.3 (open pool · billed)",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/kimi-k3-open": {
    name: "Kimi K3 (open pool · billed)",
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/qwen3.8-max-open": {
    name: "Qwen3.8 Max (open pool · billed)",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/glm-5.3": {
    name: "GLM-5.3",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/glm-5.3-flash": {
    name: "GLM-5.3 Flash",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/glm-5.2": {
    name: "GLM-5.2",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/kimi-k3": {
    name: "Kimi K3",
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/kimi-k2.7-code": {
    name: "Kimi K2.7 Code",
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/kimi-k2.6": {
    name: "Kimi K2.6",
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/minimax-m3": {
    name: "MiniMax-M3",
    contextWindow: 1048576,
    maxTokens: 512000,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/qwen3.8-max": {
    name: "Qwen3.8 Max",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/qwen3.7-max": {
    name: "Qwen3.7 Max",
    contextWindow: 1000000,
    maxTokens: 65536,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/qwen3.7-plus": {
    name: "Qwen3.7 Plus",
    contextWindow: 1000000,
    maxTokens: 64000,
    reasoning: true,
    input: ["text", "image"],
  },
  "cline-pass/mimo-v2.5-pro": {
    name: "MiMo-V2.5-Pro",
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
  },
  "cline-pass/mimo-v2.5": {
    name: "MiMo-V2.5",
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ["text", "image", "audio"],
  },
}

/** Published entry for one model id, or undefined when the catalog lacks it. */
export function catalogEntry(model: string): ModelCatalogEntry | undefined {
  const key = String(model)
  const direct = MODEL_CATALOG[key]
  if (direct !== undefined) return direct
  // The shipped table is keyed by the subscription id (`cline-pass/x`), while a
  // caller may address the same model by its open-pool slug (`vendor/x`). Try
  // the prefixed form, then the bare tail of the slug, before giving up.
  const tail = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key
  const candidates = [
    key.startsWith(MODEL_PREFIX) ? key : `${MODEL_PREFIX}${key}`,
    tail === key ? key : `${MODEL_PREFIX}${tail}`,
  ]
  for (const candidate of candidates) {
    const known = MODEL_CATALOG[candidate]
    if (known !== undefined) return known
  }
  // Dated snapshots (for example deepseek-v4.1-flash-1017) carry the same
  // context/output/modality facts as their base model. Falling back to the
  // generic 128k default here made opencode compact long sessions far too
  // early, which looks like the model "losing context".
  for (const candidate of [key, ...candidates]) {
    const dated = /^(.+)-(\d{4,})$/.exec(candidate)
    if (dated === null) continue
    const base = MODEL_CATALOG[dated[1]!]
    if (base === undefined) continue
    return { ...base, name: `${base.name} (${dated[2]})` }
  }
  return undefined
}

/**
 * Resolve one field as: configured value, then published value, then fallback.
 * Configuration schemas default absent optional fields to `0`, `''` or `[]`, so
 * an empty configured value must read as "not set".
 */
function pick<T>(configured: T | undefined, published: T | undefined, fallback: T): T {
  const set = Array.isArray(configured)
    ? configured.length > 0
    : configured !== undefined && configured !== null && (configured as unknown) !== "" && (configured as unknown) !== 0
  if (set) return configured as T
  if (published !== undefined && published !== null) return published
  return fallback
}

/** The host's whole input-modality vocabulary for this route. */
const SEAM_MODALITIES = new Set(["text", "image"])

/**
 * The output budget to advertise for one model.
 *
 * `defaultMaxTokens` is what a request asks for, not what the model can emit.
 * The published ceiling clamps the configured budget rather than becoming it;
 * a budget is also never taken past half the window.
 */
export function resolveOutputBudget(
  budget: number | undefined,
  ceiling: number | undefined,
  contextWindow: number | undefined,
): number | undefined {
  const wanted = Number.isFinite(budget) && (budget as number) > 0 ? (budget as number) : undefined
  const most = Number.isFinite(ceiling) && (ceiling as number) > 0 ? (ceiling as number) : undefined
  const chosen = wanted === undefined ? most : most === undefined ? wanted : Math.min(wanted, most)
  if (chosen === undefined) return undefined
  const half =
    Number.isFinite(contextWindow) && (contextWindow as number) > 0
      ? Math.floor((contextWindow as number) / 2)
      : undefined
  return half === undefined ? chosen : Math.min(chosen, half)
}

export interface MetadataFallback {
  contextWindow: number
  maxTokens: number
  reasoning: boolean
}

/**
 * Resolve the metadata fields for one model.
 *
 * Precedence per field: the configured override, then the shipped catalog, then
 * what the last official scan published, then the route-wide fallback. The
 * output budget is the exception — there the published figure is a ceiling that
 * bounds the configured budget.
 */
export function resolveModelMetadata(
  provider: string,
  model: string,
  override: Partial<ModelProfile>,
  fallback: MetadataFallback,
  discovered: Partial<ModelCatalogEntry> = {},
): ResolvedModel {
  const published: Partial<ModelCatalogEntry> & { inputModalities?: string[] } = {
    ...(discovered ?? {}),
    ...(catalogEntry(model) ?? {}),
  }
  const name = pick(override?.name, published.name, model)
  const contextWindow = pick(override?.contextWindow, published.contextWindow, fallback.contextWindow)
  const maxTokens = resolveOutputBudget(
    fallback.maxTokens,
    pick(override?.maxTokens, published.maxTokens, undefined as unknown as number | undefined),
    contextWindow,
  )
  const modality = pick(override?.input, published.input ?? published.inputModalities, undefined as unknown as string[] | undefined)
  const reasoning = override?.reasoning ?? published.reasoning ?? fallback.reasoning
  const offered = (modality ?? ["text"]).filter((entry) => SEAM_MODALITIES.has(entry))
  return {
    provider,
    id: model,
    name,
    inputModalities: offered.length > 0 ? offered : ["text"],
    context: { contextWindow },
    ...(maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens }),
    ...(reasoning === true ? { reasoning: true } : {}),
  }
}

/**
 * Best context-window guess for one model: the largest window discovered for
 * its endpoints, when a probe has seen them.
 */
export function discoveredContext(meta: ModelMeta | undefined): number | undefined {
  const detail = meta?.upstreamDetail ?? {}
  let max = 0
  for (const entry of Object.values(detail)) max = Math.max(max, Number(entry?.context ?? 0))
  return max > 0 ? max : undefined
}

/**
 * The provider model entry for one resolved model.
 *
 * Modalities and output limit are what the host uses to decide whether to send
 * images and how much completion room to reserve. `reasoning_options` makes it
 * build one variant per effort, and each variant becomes a `reasoning_effort`
 * field on the wire.
 *
 * The window is written twice on purpose. opencode reads `limit.context`, while
 * the pi-ai layer underneath dsh reads a top-level `contextWindow` and ignores
 * `limit` entirely. Publishing only the nested form left dsh resolving every
 * model to its route-wide `defaultContextWindow` — a 1M-window model advertised
 * as 128k, which compacts a session long before the model is actually full.
 */
export function toOpencodeModelConfig(resolved: ResolvedModel): Record<string, unknown> {
  const reasoning = resolved.reasoning === true
  const output = resolved.defaultMaxTokens ?? 64000
  return {
    name: resolved.name,
    attachment: resolved.inputModalities.includes("image"),
    reasoning,
    tool_call: true,
    temperature: true,
    limit: {
      context: resolved.context.contextWindow,
      output,
    },
    // pi-ai (dsh) reads these; opencode ignores them.
    contextWindow: resolved.context.contextWindow,
    maxTokens: output,
    modalities: {
      input: resolved.inputModalities,
      output: ["text"],
    },
    ...(reasoning
      ? {
          reasoning_options: [{ type: "effort", values: [...REASONING_EFFORT_IDS] }],
          variants: Object.fromEntries(
            REASONING_EFFORT_IDS.map((effort) => [effort, { reasoningEffort: effort }]),
          ),
        }
      : {}),
  }
}

/** The subscription prefix every Cline Pass model id carries upstream. */
export const MODEL_PREFIX = "cline-pass/"

/**
 * The model key opencode should use: the bare id after the subscription
 * prefix, so the full reference reads `cline-pass/glm-5.2` rather than
 * `cline-pass/cline-pass/glm-5.2`.
 */
export function providerModelKey(id: string): string {
  const value = String(id)
  return value.startsWith(MODEL_PREFIX) ? value.slice(MODEL_PREFIX.length) : value
}

/**
 * The upstream wire model id for a model key opencode sent.
 *
 * An alias wins over the plain prefix rule: it is the only way to address a
 * model the subscription publishes when that id now resolves to a VMC, because
 * the alias names the open-pool slug the gateway still routes freely.
 */
export function wireModelId(id: string, aliases: Record<string, string> = {}): string {
  const value = String(id).trim()
  if (value.length === 0) return value
  const direct = aliases[value]
  if (typeof direct === "string" && direct.length > 0) return direct
  const wire = value.includes("/") ? value : `${MODEL_PREFIX}${value}`
  const aliased = aliases[wire]
  if (typeof aliased === "string" && aliased.length > 0) return aliased
  return wire
}

/** Whether an id already names a concrete model rather than a subscription key. */
export function isSlugModelId(id: string): boolean {
  const value = String(id).trim()
  return value.includes("/") && !value.startsWith(MODEL_PREFIX)
}
