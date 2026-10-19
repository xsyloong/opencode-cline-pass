/**
 * opencode-cline-pass — a self-contained Cline Pass provider for opencode.
 *
 * opencode plugins cannot register an LLM adapter directly, so this plugin:
 *
 * 1. starts a loopback OpenAI-compatible gateway (the dsh adapter's transport,
 *    pinning, account pool, and failover, moved into an HTTP server);
 * 2. registers that gateway as the `cline-pass` provider — through the v1
 *    `config` hook and the v2 `provider.transform` — so its models appear in
 *    the model picker with no proxy process to run;
 * 3. registers the `cline_pass_*` management tools when `exposeTools` is on;
 * 4. serves a dashboard at the gateway root for accounts, quota, pins, probes,
 *    and request history.
 *
 * Configuration lives in `~/.config/opencode/cline-pass.json` (with a project
 * override under `.opencode/cline-pass.json`); keys live in a separate 0600
 * credential file. See docs/FUNCTIONAL-MODULES.md for the ported spec.
 */
import type { Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import { providerModelKey } from "./catalog.js"
import { errorChain } from "./errors.js"
import { BUILD_TAG } from "./protocol.js"
import { createRuntime, type Runtime } from "./runtime.js"
import { registerV2, type V2Context } from "./v2.js"

export const name = "cline-pass"
export const DEFAULT_PROVIDER = "cline-pass"
export const DEFAULT_SETTINGS_NS = "cline-pass"
export const DEFAULT_API_KEY_ENV = "CLINE_PASS_API_KEY"

export { MODEL_CATALOG, REASONING_EFFORTS } from "./catalog.js"
export { ConfigStore, configPaths, defaultConfig, normalizeConfig } from "./config.js"
export { createControl } from "./control.js"
export { createEngine, Engine } from "./engine.js"
export { createStore, ObservationStore } from "./store.js"
export { createTools } from "./tools.js"
export { createUpstreamSlots } from "./slots.js"
export { createDashboardApi, dashboardHTML } from "./dashboard.js"
export { ClinePassGateway, startGateway } from "./server.js"
export { createRuntime } from "./runtime.js"
export { registerV2, v2ModelInfo } from "./v2.js"
export {
  BUILD_TAG,
  buildAttempts,
  channelNameFor,
  injectPrefs,
  isAdherenceOk,
  normalizePinMode,
  parseRouting,
  pinAdherence,
  pinWarnings,
} from "./protocol.js"
export { ClinePassError, QUOTA_EXCEEDED_CODE, AUTH_CODE, codeForStatus, mapUsage } from "./errors.js"
export type {
  AccountProfile,
  AccountView,
  Attempt,
  HistoryEntry,
  ModelCatalogEntry,
  ModelMeta,
  ModelProfile,
  PinProfile,
  PluginConfig,
  ResolvedAccount,
  ResolvedModel,
  TraceRow,
  UpstreamVerdict,
  Usage,
  UsageAccount,
} from "./types.js"

/** Register the provider in a v1 config object. */
async function injectV1Provider(target: any, runtime: Runtime): Promise<void> {
  const current = runtime.control.readConfig()
  if (target === null || typeof target !== "object") return
  if (target.provider === null || typeof target.provider !== "object") target.provider = {}
  const providerId = current.provider || DEFAULT_PROVIDER
  const existing = target.provider[providerId] ?? {}
  const hidden = (current.hiddenModels ?? []).map((id) => providerModelKey(String(id)))
  const hiddenSet = new Set(hidden)
  const whitelist = Array.isArray(existing.whitelist)
    ? existing.whitelist.map(String).filter((id: string) => !hiddenSet.has(providerModelKey(id)))
    : undefined
  target.provider[providerId] = {
    ...existing,
    npm: "@ai-sdk/openai-compatible",
    name: current.displayName,
    options: {
      ...(existing.options ?? {}),
      baseURL: runtime.gateway.baseURL,
      // A loopback gateway accepts any bearer; the token keeps a stray local
      // process from spending the account pool by accident.
      apiKey: runtime.gateway.token,
    },
    models: {
      ...(existing.models ?? {}),
      ...runtime.control.opencodeModels(),
    },
    ...(hidden.length > 0 ? { blacklist: [...new Set([...(existing.blacklist ?? []), ...hidden])] } : {}),
    ...(whitelist === undefined ? {} : { whitelist }),
  }
  runtime.logger.info(
    '[cline-pass] provider "%s" registered at %s with %d visible model(s)',
    providerId,
    runtime.gateway.baseURL,
    runtime.control.modelIds().length,
  )
}

/** The v1 plugin factory. */
export const ClinePassPlugin: Plugin = async (input, options: PluginOptions = {}) => {
  const runtime = await createRuntime({
    directory: input?.directory || input?.worktree || process.cwd(),
    ...((options as { fetchImpl?: typeof fetch }).fetchImpl === undefined
      ? {}
      : { fetchImpl: (options as { fetchImpl?: typeof fetch }).fetchImpl }),
  })

  return {
    /**
     * Inject the provider. v1 reads `cfg.provider` after every plugin's config
     * hook, so this is the supported way for a plugin to add a provider. The
     * gateway token is process-local and never written to disk.
     */
    config: async (cfgTarget: any) => {
      await injectV1Provider(cfgTarget, runtime)
    },
    ...(runtime.tools === undefined ? {} : { tool: runtime.tools }),
    event: async ({ event }) => {
      // Surface a session error once in the plugin log; the session UI already
      // shows it, so this is for post-mortem correlation with gateway history.
      if (event?.type === "session.error") {
        const properties = (event as { properties?: { error?: { message?: string } } }).properties
        const message = properties?.error?.message
        if (typeof message === "string" && message.includes("cline-pass")) {
          runtime.logger.warn("[cline-pass] session error: %s", message)
        }
      }
    },
    dispose: runtime.dispose,
  }
}

/** The v2 setup factory: same runtime, projected through transforms. */
export async function ClinePassSetup(ctx: V2Context): Promise<() => Promise<void>> {
  const directory = ctx?.location?.directory ?? process.cwd()
  const runtime = await createRuntime({ directory })
  try {
    await registerV2(ctx, runtime)
  } catch (error) {
    await runtime.dispose()
    throw new Error(`cline-pass: v2 registration failed: ${errorChain(error)}`, { cause: error })
  }
  runtime.logger.info("[cline-pass] v2 setup complete (build %s)", BUILD_TAG)
  return runtime.dispose
}

/**
 * The module opencode's loaders recognise.
 *
 * v2 requires a default export `{ id, setup }`; v1 requires `{ id, server }`.
 * `server` is non-enumerable so v2's schema decode never sees it, while v1's
 * `"server" in value` check still does.
 */
const pluginModule: Record<string, unknown> = {
  id: "cline-pass",
  setup: ClinePassSetup,
}
Object.defineProperty(pluginModule, "server", {
  value: ClinePassPlugin,
  enumerable: false,
  configurable: false,
})

export default pluginModule as unknown as PluginModule
