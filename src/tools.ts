/**
 * The model-facing `cline_pass_*` management tools.
 *
 * They read and write the same configuration the provider runs from, so a pin
 * written here takes effect on the next model call.
 */
import { tool } from "@opencode-ai/plugin"
import { accountProfileFor } from "./accounts.js"
import type { Control } from "./control.js"
import { projectModel, firstLine } from "./dashboard.js"
import type { Engine } from "./engine.js"
import type { Logger } from "./log.js"
import { BUILD_TAG, normalizeCapabilities, normalizePinMode, pinWarnings } from "./protocol.js"
import type { ObservationStore } from "./store.js"
import type { AccountProfile, PinProfile } from "./types.js"

const z = tool.schema

/** Collapse a value into one display line. */
const line = (value: unknown, max = 200): string => firstLine(value, max)

/** Human label for one upstream availability verdict. */
const STATUS_LABEL: Record<string, string> = {
  ok: "available",
  limited: "rate-limited",
  bad: "not-pinnable",
  auth: "auth-failed",
  "not-adopted": "not-adopted",
  unknown: "unknown",
}
const statusLabel = (status: string): string => STATUS_LABEL[status] ?? String(status ?? "unknown")

export interface ToolsOptions {
  control: Control
  engine: Engine
  store: ObservationStore
  logger: Logger
  /** Where the management dashboard is served. */
  dashboardUrl: string
}

/**
 * Build the eight tools. Returning the map lets the plugin gate registration on
 * `exposeTools` without importing the tool registry itself.
 */
export function createTools(options: ToolsOptions): Record<string, ReturnType<typeof tool>> {
  const { control, engine, store } = options
  const readConfig = () => control.readConfig()
  /** One model's stored pin, read under the id the gateway actually sees. */
  const pinOf = (model: string): Partial<PinProfile> => {
    const config = readConfig()
    const wire = control.wireModel(model)
    return Object.hasOwn(config.perModel ?? {}, wire) ? config.perModel[wire]! : {}
  }

  const statusTool = tool({
    description:
      "Report the Cline Pass provider state: route, accounts and whether each key is stored, account mode, model and pin counts. Read-only and free. Check this first when a Cline Pass model fails.",
    args: {},
    async execute() {
      const config = readConfig()
      const accounts = await control.accountsWithKeys()
      const pinned = Object.values(config.perModel ?? {}).filter(
        (pin) => Array.isArray(pin?.upstreams) && pin.upstreams.length > 0,
      ).length
      const probed = store.allMeta().filter((meta) => meta.pipeline !== undefined && meta.pipeline !== null).length
      const rows = accounts.map(
        (account) =>
          `  ${account.key}${account.enabled ? "" : " (disabled)"} key=${
            account.keyConfigured ? account.keyHint : "NOT SET"
          } ref=${account.apiKeyEnv}`,
      )
      return [
        `${config.displayName} provider "${control.providerName}" @ ${config.baseURL}`,
        `route registered=true settings=${control.settingsAvailable() ? "available" : "UNAVAILABLE"}`,
        `dashboard=${options.dashboardUrl}/ build=${BUILD_TAG}`,
        `config=${control.configPath}`,
        `accountMode=${config.accountMode} active=${config.activeAccount || "(first enabled)"} effective=${(await control.effectiveAccount()) || "-"}`,
        `accounts (${accounts.length}):`,
        ...rows,
        `models: known=${(config.knownModels ?? []).length} pinned=${pinned} probed=${probed}`,
        control.configError === undefined ? "" : `CONFIG ERROR: ${control.configError}`,
      ]
        .filter((row) => row !== "")
        .join("\n")
    },
  })

  const modelsTool = tool({
    description:
      'List the Cline Pass models with their pipeline, discovered channels, per-channel verdicts, visibility and stored pin. Pass `model` to filter by substring, `refresh: true` to rescan the official model list, `model` + `visible` to show/hide one model in every picker, or `mode` to show/hide them all at once. On opencode v2 the provider inventory is refreshed live after a visibility/catalog change; if the picker does not update, restart opencode. On v1 a restart is required. Free unless `refresh` is set.',
    args: {
      model: z.string().optional().describe('Only return models whose id contains this text, e.g. "glm-5.2".'),
      refresh: z.boolean().optional().describe("Rescan the official model list first and adopt new ids."),
      visible: z
        .boolean()
        .optional()
        .describe(
          "With `model` (an exact id): true offers it in the model pickers again, false hides it from them. Hiding never removes it from the subscription list.",
        ),
      mode: z
        .enum(["all", "none", "invert"])
        .optional()
        .describe(
          'Bulk visibility: "all" shows every subscription model, "none" hides every one, "invert" swaps the two. One write, so the set can never half-apply.',
        ),
    },
    async execute(args) {
      const config = readConfig()
      let added: string[] = []
      let catalog = store.catalog()
      if (args.refresh === true) {
        const scan = await control.refreshCatalog()
        added = scan.added
        catalog = store.catalog()
      }
      const hidden = new Set((config.hiddenModels ?? []).map(String))
      if (args.mode !== undefined) {
        const known = (config.knownModels ?? []).map(String)
        const next = known.filter((id) => {
          const wasHidden = hidden.has(id)
          return args.mode === "all" ? false : args.mode === "none" ? true : !wasHidden
        })
        hidden.clear()
        for (const id of next) hidden.add(id)
        await control.updateConfig({ hiddenModels: next })
        await control.refreshModels()
      } else if (typeof args.visible === "boolean") {
        const target = control.wireModel(String(args.model ?? "").trim())
        if (!(config.knownModels ?? []).map(String).includes(target)) {
          throw new Error(`${JSON.stringify(target)} is not one of this route's subscription models`)
        }
        if (args.visible) hidden.delete(target)
        else hidden.add(target)
        await control.updateConfig({ hiddenModels: [...hidden] })
        await control.refreshModels()
      }
      const needle = String(args.model ?? "").trim().toLowerCase()
      const models = (config.knownModels ?? [])
        .filter((id) => needle === "" || String(id).toLowerCase().includes(needle))
        .map((id) => {
          const wire = control.wireModel(String(id))
          return projectModel(id, control.pinFor(id), store.metaOf(wire), hidden.has(String(id)), wire)
        })
      const blocks = models.map((model) => {
        const rows = [
          `${model.id}  pipeline=${model.pipeline || "unknown"}${
            model.pinnable ? "" : " (not pinnable)"
          }${model.pinInert ? ` (pins inert — the route never reads them)` : ""}${
            model.capabilityGated ? ` (VMC ${model.virtualModel || "?"} — pins work only through the capability gate)` : ""
          }${model.wire === model.id ? "" : ` → ${model.wire}`}${
            model.hidden ? " (hidden from pickers)" : ""
          }`,
          `  pinned=${model.pinned.length === 0 ? "(auto)" : model.pinned.join(" > ")} mode=${model.pinMode}${
            model.sort === "" ? "" : ` sort=${model.sort}`
          }${model.excluded.length === 0 ? "" : ` excluded=${model.excluded.join(",")}`}${
            model.capabilities.length === 0 ? "" : ` gate=${model.capabilities.join("+")}`
          }`,
        ]
        if (model.upstreams.length > 0) {
          const verdicts = new Map(model.upstreamStatus.map((entry) => [entry.upstream, entry.status]))
          rows.push(
            `  upstreams: ${model.upstreams
              .map((upstream) => `${upstream}[${statusLabel(verdicts.get(upstream) ?? "unknown")}]`)
              .join(" ")}`,
          )
        } else {
          rows.push("  upstreams: (unknown — run cline_pass_probe for this model)")
        }
        if (model.lastProvider !== "") rows.push(`  last=${model.lastProvider} (${model.lastMs}ms)`)
        return rows.join("\n")
      })
      const head = `${models.length} Cline Pass model(s); official catalog=${catalog.ids?.length ?? 0}${
        (catalog.sources ?? []).length === 0 ? "" : ` via ${catalog.sources.join(",")}`
      }`
      const addedLine = added.length === 0 ? [] : [`newly adopted: ${added.join(", ")}`]
      return [head, ...addedLine, ...blocks].join("\n\n")
    },
  })

  const probeTool = tool({
    description:
      "Detect how one model is routed and harvest its pinnable upstream channels, with one tiny real request. Run it before pinning, and again when a pin that used to work stops working.",
    args: {
      model: z.string().describe('Model id, e.g. "cline-pass/glm-5.2".'),
    },
    async execute(args, context) {
      const model = control.wireModel(String(args.model).trim())
      const result = await engine.probe(model, { signal: context.abort })
      if (result.ok !== true) return `probe ${model} failed: ${line(result.error, 400)}`
      return [
        `probe ${model}: ok in ${result.ms}ms`,
        `pipeline=${result.pipeline} pinnable=${result.pinnable} canonicalSlug=${result.canonicalSlug || "-"} lastProvider=${result.lastProvider || "-"}`,
        result.virtualModel === "" ? "" : `virtualModel=${result.virtualModel} pinInert=${result.pinInert}`,
        result.capabilityGated
          ? "capabilityGated=true — this id is VMC-fixed; the pin reaches the router only because `has` travels with `only`"
          : "",
        result.warning === "" ? "" : `WARNING: ${result.warning}`,
        result.upstreams.length === 0
          ? "upstreams: (none discovered)"
          : `upstreams (${result.upstreams.length}): ${result.upstreams.join(", ")}`,
        result.tier0.length === 0 ? "" : `tier0: ${result.tier0.join(", ")}`,
      ]
        .filter((row) => row !== "")
        .join("\n")
    },
  })

  const validateTool = tool({
    description:
      "Test every known channel of one model, one tiny real request each, and report a verdict per channel: available, rate-limited, not-pinnable, or auth-failed. This is the ground truth behind a pin. Probe the model first so its channel list exists.",
    args: {
      model: z.string().describe('Model id, e.g. "cline-pass/glm-5.2".'),
    },
    async execute(args, context) {
      const model = control.wireModel(String(args.model).trim())
      const meta = store.metaOf(model)
      if (!Array.isArray(meta.upstreams) || meta.upstreams.length === 0) {
        return `validate ${model} failed: no known upstream channels: run cline_pass_probe for this model first`
      }
      const outcome = await engine.validate(model, { signal: context.abort })
      const rows = [...outcome.results]
        .sort((a, b) => Number(a.status !== "ok") - Number(b.status !== "ok"))
        .map(
          (entry) =>
            `${entry.upstream}: ${statusLabel(entry.status)} (${entry.ms}ms)${entry.note === "" ? "" : ` — ${entry.note}`}`,
        )
      return [
        `validate ${model}: ${outcome.results.length} upstream(s)`,
        `available=${outcome.summary.ok} rate-limited=${outcome.summary.limited} not-pinnable=${outcome.summary.bad} auth-failed=${outcome.summary.auth} unknown=${outcome.summary.unknown}`,
        ...rows,
      ].join("\n")
    },
  })

  const testTool = tool({
    description:
      "Send one small real request through a pin and report which upstream served it, with the failover trace. `upstreams` and `exclude` override the stored pin for this call only; omit both to exercise it as stored. Nothing is persisted.",
    args: {
      model: z.string().describe('Model id, e.g. "cline-pass/glm-5.2".'),
      upstreams: z.array(z.string()).optional().describe("Ordered upstream candidates for this call only."),
      exclude: z.array(z.string()).optional().describe("Upstream channels to exclude for this call only."),
    },
    async execute(args, context) {
      const model = control.wireModel(String(args.model).trim())
      const result = await engine.test(model, {
        upstreams: Array.isArray(args.upstreams) ? args.upstreams.map(String) : undefined,
        exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : undefined,
        signal: context.abort,
      })
      const trace = result.trace.map(
        (entry) =>
          `  ${entry.upstream} -> HTTP ${entry.status} in ${entry.ms}ms${entry.note === "" ? "" : ` — ${entry.note}`}`,
      )
      const head = result.ok
        ? `test ${model}: ok in ${result.ms}ms via ${result.actual || result.actualName || "(unknown)"}`
        : `test ${model}: FAILED — ${line(result.error, 400)}`
      const adherenceNote = result.ok
        ? result.adherence === "fallback"
          ? `⚠ the gateway fell back to ${result.actual || "(unknown)"}`
          : result.adherence === "unresolved" && result.targets.length > 0
            ? "⚠ the response did not name the serving channel, so the pin could not be confirmed"
            : ""
        : result.actual === ""
          ? ""
          : `actual: served by ${result.actual}`
      return [
        head,
        adherenceNote,
        ...result.warnings.map((warning) => `⚠ ${warning}`),
        result.targets.length === 0 ? "" : `pinned: ${result.targets.join(" > ")}`,
        result.excluded.length === 0 ? "" : `excluded: ${result.excluded.join(", ")}`,
        result.ok
          ? `pipeline=${result.pipeline} canonicalSlug=${result.canonicalSlug || "-"} account=${result.account || "-"}`
          : "",
        result.plan === "" ? "" : `router: ${line(result.plan, 300)}`,
        trace.length === 0 ? "" : `attempts (${trace.length}):`,
        ...trace,
        result.content === "" ? "" : `reply: ${result.content}`,
      ]
        .filter((row) => row !== "")
        .join("\n")
    },
  })

  const pinTool = tool({
    description:
      'Persist one model\'s upstream pin. `upstreams` is the candidate list, primary first (an empty array returns the model to automatic routing); `exclude` lists channels that must never be used. Both are compiled into an `only` allow-list on the wire, because the gateway drops `order` and `ignore`. `capabilities` is the gate written as `providerOptions.gateway.has` next to that allow-list: on a VMC-fixed id the planner discards `only` unless a positive capability condition is present, so this is what makes the pin real. Allowed values: free, implicit-caching, reasoning, structured-output, tool-use, vision, or a weight condition such as `quantization:fp8` / `!quantization:bf16`; the default is `["vision"]` and an empty array disables the gate. `pinMode: "strict"` allows one channel per attempt and moves to the next only when it fails; `"preferred"` allows the whole candidate set at once and falls back once, unpinned, if the set refuses. `sort` is written as a hint only — the planner pipeline ignores it. Only the fields you supply change. Returns `warnings` when a name cannot be checked or an exclusion cannot be expressed.',
    args: {
      model: z.string().describe('Model id, e.g. "cline-pass/glm-5.2".'),
      upstreams: z.array(z.string()).optional().describe("Ordered pin list; an empty array clears pinning."),
      exclude: z.array(z.string()).optional().describe("Channels that must never be used."),
      pinMode: z.enum(["strict", "preferred"]).optional().describe("How strictly to honor the pin list."),
      sort: z.enum(["cost", "ttft", "tps", "none"]).optional().describe('Reorder candidates by this metric; "none" clears it.'),
      capabilities: z
        .array(z.string())
        .optional()
        .describe(
          'Capability gate sent as `providerOptions.gateway.has` (e.g. ["vision"] or ["tool-use"]). An empty array turns the gate off, which makes pins inert on VMC-fixed ids.',
        ),
    },
    async execute(args) {
      const model = control.wireModel(String(args.model).trim())
      const config = readConfig()
      const current = pinOf(model)
      const next: PinProfile = {
        upstreams: Array.isArray(args.upstreams) ? args.upstreams.map(String) : (current.upstreams ?? []).map(String),
        exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : (current.exclude ?? []).map(String),
        pinMode: args.pinMode !== undefined ? args.pinMode : current.pinMode ?? "strict",
        sort: args.sort === undefined ? String(current.sort ?? "") : args.sort === "none" ? "" : String(args.sort),
        capabilities: Array.isArray(args.capabilities)
          ? normalizeCapabilities(args.capabilities)
          : normalizeCapabilities(current.capabilities),
      }
      await control.updateConfig({ perModel: { ...(config.perModel ?? {}), [model]: next } })
      const stored = pinOf(model)
      const meta = store.metaOf(model)
      const pinned = (stored.upstreams ?? []).map(String)
      const excluded = (stored.exclude ?? []).map(String)
      const known = Array.isArray(meta.upstreams) ? meta.upstreams.map(String) : []
      const gate =
        Array.isArray(stored.capabilities) && stored.capabilities.length > 0
          ? normalizeCapabilities(stored.capabilities)
          : config.pinCapabilities ?? []
      const warnings = [
        ...pinWarnings({ upstream: pinned[0] ?? null, excludeList: excluded, capabilities: gate }, meta),
      ]
      const named = [...pinned, ...excluded]
      if (named.length > 0) {
        if (known.length === 0) {
          warnings.push(
            `unverifiedChannel: this model has no discovered channel list yet, so ${named.join(
              ", ",
            )} cannot be checked — run cline_pass_probe for it`,
          )
        } else {
          const unknown = named.filter((name) => !known.includes(name))
          if (unknown.length > 0) {
            warnings.push(
              `unknownChannel: ${unknown.join(", ")} is not in this model's discovered channel list (${known.join(
                ", ",
              )}); confirm with cline_pass_test, because the gateway ignores a channel it cannot use rather than failing`,
            )
          }
        }
      }
      return [
        `pinned ${model}`,
        `upstreams: ${pinned.length === 0 ? "(auto)" : pinned.join(" > ")}`,
        `exclude: ${excluded.length === 0 ? "(none)" : excluded.join(", ")}`,
        `pinMode=${normalizePinMode(stored.pinMode)} sort=${stored.sort === "" ? "none" : stored.sort}`,
        `capabilities=${gate.length === 0 ? "(gate off — pins are inert on VMC ids)" : gate.join("+")}`,
        ...warnings.map((warning) => `⚠ ${warning}`),
        `note: Saved to ${control.configPath}; the next model call uses it. Run cline_pass_test to confirm the gateway honors it.`,
      ].join("\n")
    },
  })

  const accountsTool = tool({
    description:
      "Manage the Cline Pass account pool: list, add, remove, switch single/round-robin, or test a key with one real request. Keys go to the local credential store and are only ever shown masked.",
    args: {
      action: z
        .enum(["list", "add", "remove", "mode", "set", "test"])
        .describe("Operation to perform."),
      name: z.string().optional().describe("Account key (letters, digits, dot, dash, underscore)."),
      key: z.string().optional().describe("API key (sk_…), for add/test."),
      apiKeyEnv: z.string().optional().describe("Credential name holding this account key."),
      displayName: z.string().optional().describe("Human-readable label."),
      enabled: z.boolean().optional().describe("Whether the account takes part in routing."),
      baseURL: z
        .string()
        .optional()
        .describe("Override the gateway address for this account; empty uses the provider address."),
      mode: z.enum(["single", "roundrobin"]).optional().describe("Pool mode."),
      active: z.string().optional().describe("Account key used in single mode."),
      accounts: z
        .array(
          z.object({
            name: z.string(),
            apiKeyEnv: z.string().optional(),
            displayName: z.string().optional(),
            enabled: z.boolean().optional(),
            baseURL: z.string().optional(),
            key: z.string().optional(),
          }),
        )
        .optional()
        .describe("Full replacement pool, for set."),
    },
    async execute(args, context) {
      const action = String(args.action)
      let note = ""
      let ok = true
      const nameOf = (value: unknown): string => String(value ?? "").trim()
      if (action === "test") {
        let key = String(args.key ?? "").trim()
        const label = args.name === undefined ? "(supplied key)" : nameOf(args.name)
        const accounts = control.accounts()
        const account = args.name === undefined ? undefined : accounts.find((entry) => entry.key === nameOf(args.name))
        if (args.name !== undefined && account === undefined) {
          throw new Error(`no account named ${JSON.stringify(nameOf(args.name))}`)
        }
        const baseURL = account?.baseURL || readConfig().baseURL
        if (key === "") {
          if (args.name === undefined) {
            throw new Error('cline_pass_accounts action="test" needs `key` or an existing `name`')
          }
          key = await control.readCredential(account!.apiKeyEnv)
          if (key === "") {
            throw new Error(
              `account ${JSON.stringify(account!.key)} has no stored key at ${account!.apiKeyEnv}; store one with action="add" key=…`,
            )
          }
        }
        const model = (readConfig().knownModels ?? [])[0] ?? "cline-pass/glm-5.3-flash"
        const result = await engine.testAccount({ key, baseURL, model, signal: context.abort })
        ok = result.authorized === true
        note = result.authorized
          ? `key for ${label} authorized in ${result.ms}ms`
          : `key for ${label} FAILED: ${line(result.error, 200)}`
      } else if (action !== "list") {
        const config = readConfig()
        const accounts: Record<string, AccountProfile> = { ...(config.accounts ?? {}) }
        if (action === "set") {
          if (!Array.isArray(args.accounts)) {
            throw new Error('cline_pass_accounts action="set" needs `accounts`')
          }
          const next: Record<string, AccountProfile> = {}
          for (const [index, entry] of args.accounts.entries()) {
            const key = nameOf(entry?.name) || `account-${index + 1}`
            if (Object.hasOwn(next, key)) throw new Error(`duplicate account name ${JSON.stringify(key)}`)
            next[key] = accountProfileFor(key, entry, { ...accounts, ...next }, config.apiKeyEnv)
          }
          // Validate every entry before any credential or configuration write.
          for (const [index, entry] of args.accounts.entries()) {
            const key = nameOf(entry?.name) || `account-${index + 1}`
            if (typeof entry?.key === "string" && entry.key.trim() !== "") {
              await control.setCredential(next[key]!.apiKeyEnv, entry.key.trim())
              note = `stored the key for ${key} in the credential store`
            }
          }
          const removals = Object.keys(accounts)
            .filter((key) => !Object.hasOwn(next, key))
            .map((key) => ["accounts", key])
          const activeAccount = Object.hasOwn(next, String(config.activeAccount ?? "")) ? config.activeAccount : ""
          await control.updateConfig({ accounts: next, activeAccount }, removals)
        } else if (action === "add") {
          const key = nameOf(args.name)
          if (!/^[A-Za-z0-9._-]+$/.test(key)) {
            throw new Error('cline_pass_accounts action="add" needs a `name` of letters, digits, dot, dash or underscore')
          }
          // Adding the first account must not silently drop the implicit
          // default account the top-level key fields describe.
          if (Object.keys(accounts).length === 0) {
            accounts.default = {
              displayName: String(config.displayName ?? "default"),
              apiKeyEnv: String(config.apiKeyEnv ?? ""),
              enabled: true,
              baseURL: "",
            }
          }
          const profile = accountProfileFor(key, args, accounts, config.apiKeyEnv)
          accounts[key] = profile
          await control.updateConfig({ accounts })
          if (typeof args.key === "string" && args.key.trim() !== "") {
            await control.setCredential(profile.apiKeyEnv, args.key.trim())
            note = `stored the key for ${key} at ${profile.apiKeyEnv}`
          } else {
            note = `account ${key} added; store its key at ${profile.apiKeyEnv} (pass key=… next time)`
          }
        } else if (action === "remove") {
          const key = nameOf(args.name)
          if (accounts[key] === undefined) throw new Error(`no account named ${JSON.stringify(key)}`)
          const removedRef = String(accounts[key]?.apiKeyEnv ?? config.apiKeyEnv ?? "")
          delete accounts[key]
          const active = readConfig().activeAccount === key ? "" : readConfig().activeAccount
          await control.updateConfig({ accounts, activeAccount: active }, [["accounts", key]])
          note =
            Object.keys(accounts).length === 0
              ? `removed ${key}; with no accounts left, requests fall back to the top-level ${readConfig().apiKeyEnv} credential`
              : `removed ${key} (a value stored at ${removedRef} was left in place)`
        } else if (action === "mode" && args.mode === undefined) {
          throw new Error('cline_pass_accounts action="mode" needs `mode`')
        }
        // A read-only action must not rewrite the pool: `mode` and `active` are
        // applied only for the actions that are allowed to write.
        if (action !== "list" && action !== "test") {
          const patch: Record<string, unknown> = {}
          if (args.mode !== undefined) patch.accountMode = args.mode === "roundrobin" ? "roundrobin" : "single"
          if (args.active !== undefined) patch.activeAccount = nameOf(args.active)
          if (Object.keys(patch).length > 0) await control.updateConfig(patch)
        }
      }
      const config = readConfig()
      const accounts = await control.accountsWithKeys()
      return [
        `accounts.${action}: ${ok ? "ok" : "FAILED"}`,
        note === "" ? "" : `note: ${note}`,
        `accountMode=${config.accountMode} active=${config.activeAccount || "(first enabled)"} count=${accounts.length}`,
        ...accounts.map(
          (account) =>
            `  ${account.key}${account.enabled ? "" : " (disabled)"} key=${
              account.keyConfigured ? account.keyHint : "NOT SET"
            } ref=${account.apiKeyEnv}`,
        ),
      ]
        .filter((row) => row !== "")
        .join("\n")
    },
  })

  const historyTool = tool({
    description:
      "Read the in-process request history (newest first): account, upstream that served each call, latency, error. Read-only and free. In memory only, so it starts empty after a restart.",
    args: {
      limit: z.number().int().optional().describe("How many rows to return (default 25, max 100)."),
      model: z.string().optional().describe("Only return rows whose model id contains this text."),
    },
    async execute(args) {
      const limit = Number.isSafeInteger(args.limit) && (args.limit as number) > 0 ? Math.min(args.limit as number, 100) : 25
      const entries = store.readHistory(limit, args.model ?? "")
      if (entries.length === 0) return "No Cline Pass model calls recorded yet in this process."
      return [
        `last ${entries.length} of ${store.historySize()} call(s):`,
        ...entries.map((entry) => {
          const when = entry.ts === 0 ? "-" : new Date(entry.ts).toISOString()
          const attempts = entry.attempts?.length ? ` attempts=${entry.attempts.join(">")}` : ""
          const error = entry.error ? ` error=${entry.error}` : ""
          const adherence = entry.adherence ? ` adherence=${entry.adherence}` : ""
          const warnings = entry.warnings?.length ? ` warnings=${entry.warnings.length}` : ""
          const stamp = (value: number | undefined): string => ((value ?? 0) > 0 ? `${value}ms` : "—")
          const latency = `${stamp(entry.ttft)}/${entry.ms}ms`
          const usage = entry.usage
            ? ` in=${entry.usage.inputTokens} out=${entry.usage.outputTokens}${
                (entry.usage.cacheReadTokens ?? 0) > 0 ? ` cache=${entry.usage.cacheReadTokens}` : ""
              }${(entry.usage.reasoningTokens ?? 0) > 0 ? ` think=${entry.usage.reasoningTokens}` : ""}`
            : ""
          const elapsedAfterFirst = entry.ms - (entry.ttft ?? 0)
          const rate =
            entry.usage === null || entry.usage === undefined || entry.usage.outputTokens === 0 || (entry.ttft ?? 0) === 0 || elapsedAfterFirst <= 0
              ? ""
              : ` ${(entry.usage.outputTokens / (elapsedAfterFirst / 1000)).toFixed(1)}t/s`
          const effort = entry.effort ? ` effort=${entry.effort}` : ""
          return `${when} ${entry.model} -> ${entry.provider || "(auto)"}${
            entry.canonical === null || entry.canonical === undefined || entry.canonical === ""
              ? ""
              : ` [${entry.canonical}]`
          } ${latency}${rate}${entry.stream ? " stream" : ""}${effort} account=${entry.account || "-"}${usage}${attempts}${adherence}${warnings}${error}`
        }),
      ].join("\n")
    },
  })

  return {
    cline_pass_status: statusTool,
    cline_pass_models: modelsTool,
    cline_pass_probe: probeTool,
    cline_pass_validate: validateTool,
    cline_pass_test: testTool,
    cline_pass_pin: pinTool,
    cline_pass_accounts: accountsTool,
    cline_pass_history: historyTool,
  }
}
