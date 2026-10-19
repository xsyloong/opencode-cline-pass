/**
 * opencode v2 registration.
 *
 * v2 replaced the v1 hook object with a promise `setup(context)` and domain
 * transforms. The same runtime serves both: this module projects the runtime
 * into a v2 provider + model inventory and the eight tools.
 */
import { tool } from "@opencode-ai/plugin"
import { providerModelKey } from "./catalog.js"
import { REASONING_EFFORTS } from "./catalog.js"
import { openInBrowser } from "./open.js"
import type { Runtime } from "./runtime.js"
import type { ResolvedModel } from "./types.js"
import { BUILD_TAG } from "./protocol.js"

/** The subset of the v2 setup context this plugin uses. */
export interface V2ProviderEditor {
  get(providerID: string): unknown
  add(input: { info: Record<string, unknown>; models: Record<string, unknown>[] }): void
  update(providerID: string, update: (provider: Record<string, any>) => void): void
  readonly models: {
    set(providerID: string, models: Record<string, unknown>[]): void
  }
}

export interface V2ToolEditor {
  add(input: Record<string, unknown>): void
}

export interface V2CommandDefinition {
  name: string
  description?: string
  execute: (input: { sessionID?: string; prompt?: unknown; delivery?: unknown }) => Promise<void>
}

export interface V2CommandEditor {
  add(definition: V2CommandDefinition): void
}

export interface V2Context {
  location?: { directory?: string }
  provider?: {
    transform(callback: (editor: V2ProviderEditor) => void): Promise<unknown>
    reload?: () => Promise<void>
  }
  tool?: { transform(callback: (editor: V2ToolEditor) => void): Promise<unknown> }
  command?: { transform(callback: (editor: V2CommandEditor) => void): Promise<unknown> }
}

export interface V2RegisterOptions {
  /** Injected browser opener, for tests and hosts without a desktop session. */
  openDashboard?: (url: string) => void | Promise<void>
}

/** The native v2 OpenAI-compatible provider package. */
export const V2_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

/** Convert one resolved model into a v2 `Model.Info`. */
export function v2ModelInfo(model: ResolvedModel, providerID: string): Record<string, unknown> {
  const key = providerModelKey(model.id)
  return {
    id: key,
    // The wire id the gateway expects. The internal id stays bare so a user
    // selects the familiar `cline-pass/glm-5.2`.
    modelID: model.id,
    providerID,
    name: model.name,
    compatibility: { reasoningField: "reasoning_content" },
    capabilities: {
      tools: true,
      input: model.inputModalities.length > 0 ? model.inputModalities : ["text"],
      output: ["text"],
    },
    variants:
      model.reasoning === true
        ? REASONING_EFFORTS.map((effort) => ({
            id: effort.id,
            settings: { reasoningEffort: effort.id },
          }))
        : [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: model.context.contextWindow,
      output: model.defaultMaxTokens ?? 64000,
    },
  }
}

/** Register the provider, its models, the tools, and the `/cline-pass` command on a v2 context. */
export async function registerV2(
  ctx: V2Context,
  runtime: Runtime,
  options: V2RegisterOptions = {},
): Promise<void> {
  const cfg = runtime.control.readConfig()
  const providerID = cfg.provider || "cline-pass"
  if (ctx.provider === undefined || typeof ctx.provider.transform !== "function") {
    throw new Error("cline-pass: this opencode build has no provider.transform; upgrade opencode or use the v1 plugin entry")
  }
  // Build tool definitions before registering anything: a schema conversion
  // failure must not leave a provider pointing at a gateway we then close.
  const toolDefinitions: Record<string, unknown>[] = []
  if (runtime.tools !== undefined) {
    for (const [name, definition] of Object.entries(runtime.tools)) {
      toolDefinitions.push({
        name,
        description: definition.description,
        input: tool.schema.toJSONSchema(tool.schema.object(definition.args)) as Record<string, unknown>,
        options: { codemode: false },
        execute: async (value: Record<string, unknown>, context: { signal?: AbortSignal }) => {
          const output = await definition.execute(value as never, { abort: context.signal } as never)
          // v2 rejects `output` unless the tool declares an output schema;
          // `content` is the schema-free text lane and is what the model sees.
          return { content: String(output) }
        },
      })
    }
  }

  await ctx.provider.transform((editor) => {
    // Read the live configuration inside the transform: a visibility change
    // triggers `provider.reload()`, which re-runs this callback and replaces
    // the model inventory without a process restart.
    const current = runtime.control.readConfig()
    const models = runtime.control.connection().models.map((model) => v2ModelInfo(model, providerID))
    const info = {
      id: providerID,
      name: current.displayName,
      activation: "enabled",
      package: V2_PROVIDER_PACKAGE,
      integrationID: undefined,
      compatibility: { reasoningField: "reasoning_content" },
      settings: {
        baseURL: runtime.gateway.baseURL,
        apiKey: runtime.gateway.token,
        provider: providerID,
        // Long agent turns are normal; the gateway owns the idle watchdog, so
        // the outer HTTP call must not impose a total-request deadline.
        timeout: false,
      },
    }
    const existing = editor.get(providerID)
    if (existing === undefined) {
      editor.add({ info, models })
      return
    }
    editor.update(providerID, (provider) => {
      Object.assign(provider, info)
    })
    editor.models.set(providerID, models)
  })
  runtime.control.setModelRefresher(async () => {
    if (ctx.provider?.reload !== undefined) await ctx.provider.reload()
  })

  if (toolDefinitions.length > 0) {
    if (ctx.tool === undefined || typeof ctx.tool.transform !== "function") {
      runtime.logger.warn("[cline-pass] v2 host has no tool.transform; the management tools are not registered")
    } else {
      await ctx.tool.transform((editor) => {
        for (const definition of toolDefinitions) editor.add(definition)
      })
    }
  }

  if (ctx.command === undefined || typeof ctx.command.transform !== "function") {
    runtime.logger.warn("[cline-pass] v2 host has no command.transform; the /cline-pass dashboard command is not registered")
  } else {
    const openDashboard =
      options.openDashboard ??
      ((url: string) => {
        openInBrowser(url, { logger: runtime.logger })
      })
    await ctx.command.transform((editor) => {
      editor.add({
        name: "cline-pass",
        description: "Open the Cline Pass dashboard (accounts, quota, pins, history)",
        async execute() {
          const cfg = runtime.control.readConfig()
          if (cfg.dashboard === false) {
            throw new Error("the Cline Pass dashboard is disabled (dashboard: false)")
          }
          const url = runtime.gateway.url
          if (url.length === 0) throw new Error("the Cline Pass gateway is not running")
          await openDashboard(`${url}/`)
        },
      })
    })
    runtime.logger.info("[cline-pass] v2 command /cline-pass registered")
  }

  runtime.logger.info(
    '[cline-pass] v2 provider "%s" registered at %s with %d visible model(s) (build %s)',
    providerID,
    runtime.gateway.baseURL,
    runtime.control.modelIds().length,
    BUILD_TAG,
  )
}
