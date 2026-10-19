import { describe, expect, it } from "vitest"
import { createDashboardApi } from "../src/dashboard.js"
import { silentLogger } from "../src/log.js"
import { bodyOf, makeRuntime, TEST_KEY } from "./helpers.js"

const MODEL = "cline-pass/glm-5.2"
const accounts = {
  a: { displayName: "A", apiKeyEnv: "KEY_A", enabled: true, baseURL: "" },
  b: { displayName: "B", apiKeyEnv: "KEY_B", enabled: true, baseURL: "" },
}
const env = { KEY_A: TEST_KEY, KEY_B: "sk_b_1234567890" }

function fetchMock(requests: any[] = []): typeof fetch {
  return async (url, init) => {
    const target = String(url)
    const body = bodyOf(init)
    requests.push({ url: target, body })
    if (target.includes("usage-limits")) {
      return Response.json({
        data: { limits: [{ type: "weekly", percentUsed: 12, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] },
      })
    }
    if (target.includes("recommended-models")) {
      return Response.json({ clinePass: ["cline-pass/glm-5.2", "cline-pass/new-model"] })
    }
    if (target.includes("models.dev")) return Response.json({})
    if (target.includes("/chat/completions")) {
      if (body?.providerOptions?.gateway?.only?.[0] === "__probe__") {
        return Response.json({ error: { message: "Available providers are: alibaba, baseten." } }, { status: 400 })
      }
      if (body?.provider?.only?.[0] === "__probe__") {
        return Response.json(
          { error: { message: JSON.stringify({ error: { metadata: { available_providers: ["z-ai"] } } }) } },
          { status: 400 },
        )
      }
      return Response.json({
        choices: [
          {
            message: {
              content: "OK",
              provider_metadata: { gateway: { routing: { finalProvider: "alibaba" } } },
            },
          },
        ],
      })
    }
    if (target.endsWith("/models")) return Response.json({ data: [] })
    return Response.json({})
  }
}

async function dashboard(config: Record<string, unknown> = {}, requests: any[] = []) {
  const runtime = await makeRuntime({
    config: { knownModels: [MODEL], accounts, accountMode: "single", activeAccount: "a", ...config },
    env,
    fetchImpl: fetchMock(requests),
  })
  const api = createDashboardApi({
    control: runtime.control,
    engine: runtime.engine,
    store: runtime.store,
    logger: silentLogger,
    dashboardUrl: "http://127.0.0.1:9999",
    fetchImpl: fetchMock(requests),
  })
  return { runtime, api, requests }
}

describe("dashboard api", () => {
  it("reports a complete snapshot without leaking keys", async () => {
    const { api } = await dashboard()
    const state: any = await api.state({})
    expect(state).toMatchObject({
      provider: "cline-pass",
      displayName: "Cline Pass",
      accountMode: "single",
      activeAccount: "a",
      effectiveAccount: "a",
      ready: true,
      dashboardUrl: "http://127.0.0.1:9999",
      build: "opencode-1",
    })
    expect(state.accounts).toHaveLength(2)
    expect(state.models).toHaveLength(1)
    expect(JSON.stringify(state)).not.toContain(TEST_KEY)
  })

  it("adds, enables, switches and removes accounts", async () => {
    const { api, runtime } = await dashboard()
    await api["account.add"]({ name: "c", key: "sk_c_1234567890", displayName: "C" })
    expect(runtime.control.readConfig().accounts.c?.displayName).toBe("C")
    expect(await runtime.config.resolveCredential("CLINE_PASS_C_KEY")).toBe("sk_c_1234567890")

    await api["account.enable"]({ name: "c", enabled: false })
    expect(runtime.control.readConfig().accounts.c?.enabled).toBe(false)

    await api["account.mode"]({ mode: "roundrobin", active: "c" })
    expect(runtime.control.readConfig()).toMatchObject({ accountMode: "roundrobin", activeAccount: "c" })

    await api["account.remove"]({ name: "c" })
    expect(runtime.control.readConfig().accounts.c).toBeUndefined()
    expect(runtime.control.readConfig().activeAccount).toBe("")
    // Removing an account keeps the stored credential for a future re-add.
    expect(await runtime.config.resolveCredential("CLINE_PASS_C_KEY")).toBe("sk_c_1234567890")
  })

  it("stores and tests a key without persisting a typed test value", async () => {
    const { api, runtime, requests } = await dashboard()
    await api["key.set"]({ ref: "KEY_A", value: "sk_rotated_1234567890" })
    expect(await runtime.config.resolveCredential("KEY_A")).toBe("sk_rotated_1234567890")
    const typed = await api["key.test"]({ ref: "KEY_A", value: "sk_typed_1234567890" })
    expect(typed.ok).toBe(true)
    // The typed value is used, not stored.
    expect(requests.at(-1).body.messages[0].content).toBe("Say OK")
    expect(await runtime.config.resolveCredential("KEY_A")).toBe("sk_rotated_1234567890")
  })

  it("persists a pin and resets it", async () => {
    const { api, runtime } = await dashboard()
    const pinned: any = await api["model.pin"]({
      model: "glm-5.2",
      upstreams: ["a", "b"],
      exclude: ["c"],
      pinMode: "preferred",
      sort: "cost",
    })
    expect(pinned.model).toBe(MODEL)
    expect(runtime.control.readConfig().perModel[MODEL]).toEqual({
      upstreams: ["a", "b"],
      exclude: ["c"],
      pinMode: "preferred",
      sort: "cost",
    })
    const reset: any = await api["model.reset"]({ model: "glm-5.2" })
    expect(reset.model).toBe(MODEL)
    expect(runtime.control.readConfig().perModel[MODEL]).toEqual({
      upstreams: [],
      exclude: [],
      pinMode: "preferred",
      sort: "",
    })
  })

  it("hides one model and then all of them", async () => {
    const { api, runtime } = await dashboard()
    let refreshes = 0
    runtime.control.setModelRefresher(async () => {
      refreshes += 1
    })
    const hidden: any = await api["model.visibility"]({ model: "glm-5.2", visible: false })
    expect(hidden.models[0].hidden).toBe(true)
    expect(runtime.control.readConfig().hiddenModels).toEqual([MODEL])
    expect(refreshes).toBe(1)

    await api["models.visibility"]({ mode: "all" })
    expect(runtime.control.readConfig().hiddenModels).toEqual([])
    await api["models.visibility"]({ mode: "none" })
    expect(runtime.control.readConfig().hiddenModels).toEqual([MODEL])
    await api["models.visibility"]({ mode: "invert" })
    expect(runtime.control.readConfig().hiddenModels).toEqual([])
  })

  it("probes a model and records the discovered channels", async () => {
    const { api, runtime } = await dashboard()
    const result: any = await api["model.probe"]({ model: "glm-5.2" })
    expect(result.model).toBe(MODEL)
    expect(result.result.ok).toBe(true)
    expect(result.result.pipeline).toBe("planner")
    expect(result.result.upstreams).toEqual(["alibaba", "baseten", "z-ai"])
    expect(runtime.store.metaOf(MODEL).pipeline).toBe("planner")
  })

  it("reads quota per account and caches the reading", async () => {
    const { api, runtime } = await dashboard()
    const result: any = await api.usage({})
    expect(result.usage.ok).toBe(true)
    expect(result.usage.accounts).toHaveLength(2)
    expect(result.usage.accounts[0].limits[0]).toMatchObject({ type: "weekly", percentUsed: 12 })
    expect(runtime.store.usage().accounts).toHaveLength(2)
  })

  it("refreshes the official catalog and adopts new ids", async () => {
    const { api, runtime } = await dashboard()
    const result: any = await api["models.refresh"]({})
    expect(result.added).toEqual(["cline-pass/new-model"])
    expect(runtime.control.readConfig().knownModels).toContain("cline-pass/new-model")
    expect(runtime.store.catalog().sources).toContain("cline.api")
  })

  it("reads history and answers an unknown action with a refusal", async () => {
    const { api, runtime } = await dashboard()
    runtime.store.record({
      model: MODEL,
      stream: true,
      account: "a",
      ms: 12,
      provider: "deepseek",
      attempts: ["deepseek"],
      adherence: "adopted",
      warnings: [],
    })
    const history: any = await api.history({ limit: 10 })
    expect(history.total).toBe(1)
    expect(history.entries[0]).toMatchObject({
      model: MODEL,
      account: "a",
      ms: 12,
      provider: "deepseek",
      adherence: "adopted",
      attempts: ["deepseek"],
    })
    expect(api["nope"]).toBeUndefined()
  })
})
