import { describe, expect, it } from "vitest"
import { createTools } from "../src/tools.js"
import { silentLogger } from "../src/log.js"
import { makeRuntime, TEST_KEY } from "./helpers.js"

const MODEL = "cline-pass/glm-5.2"
const accounts = {
  a: { displayName: "A", apiKeyEnv: "KEY_A", enabled: true, baseURL: "" },
  b: { displayName: "B", apiKeyEnv: "KEY_B", enabled: true, baseURL: "" },
}
const env = { KEY_A: TEST_KEY, KEY_B: "sk_b_1234567890" }
const ctx = { abort: new AbortController().signal, sessionID: "s", messageID: "m", agent: "build", directory: "/", worktree: "/" } as any

async function tools(config: Record<string, unknown> = {}) {
  const runtime = await makeRuntime({
    config: { knownModels: [MODEL], accounts, accountMode: "single", activeAccount: "a", ...config },
    env,
  })
  return {
    runtime,
    tools: createTools({
      control: runtime.control,
      engine: runtime.engine,
      store: runtime.store,
      logger: silentLogger,
      dashboardUrl: "http://127.0.0.1:9999",
    }),
  }
}

describe("management tools", () => {
  it("reports status with a dashboard address and no key material", async () => {
    const { tools: registry } = await tools()
    const text = await registry.cline_pass_status.execute({}, ctx)
    expect(text).toContain('provider "cline-pass"')
    expect(text).toContain("dashboard=http://127.0.0.1:9999/")
    expect(text).toContain("accounts (2)")
    expect(text).not.toContain(TEST_KEY)
  })

  it("adds an account and stores its key", async () => {
    const { tools: registry, runtime } = await tools()
    const text = await registry.cline_pass_accounts.execute(
      { action: "add", name: "main", key: "sk_main_1234567890", displayName: "Main" },
      ctx,
    )
    expect(text).toContain("accounts.add: ok")
    expect(runtime.control.readConfig().accounts.main).toMatchObject({ displayName: "Main", enabled: true })
    expect(await runtime.config.resolveCredential("CLINE_PASS_MAIN_KEY")).toBe("sk_main_1234567890")
  })

  it("replaces the pool with set and clears an active account that vanished", async () => {
    const { tools: registry, runtime } = await tools()
    const text = await registry.cline_pass_accounts.execute(
      { action: "set", accounts: [{ name: "b", apiKeyEnv: "KEY_B" }] },
      ctx,
    )
    expect(text).toContain("accounts.set: ok")
    expect(Object.keys(runtime.control.readConfig().accounts)).toEqual(["b"])
    expect(runtime.control.readConfig().activeAccount).toBe("")
  })

  it("switches mode without honoring stray fields on a list", async () => {
    const { tools: registry, runtime } = await tools()
    await registry.cline_pass_accounts.execute({ action: "list", mode: "roundrobin" }, ctx)
    expect(runtime.control.readConfig().accountMode).toBe("single")
    await registry.cline_pass_accounts.execute({ action: "mode", mode: "roundrobin" }, ctx)
    expect(runtime.control.readConfig().accountMode).toBe("roundrobin")
  })

  it("persists a pin and warns about an undiscovered channel", async () => {
    const { tools: registry, runtime } = await tools()
    const text = await registry.cline_pass_pin.execute(
      { model: "glm-5.2", upstreams: ["alibaba", "baseten"], exclude: ["deepseek"], pinMode: "preferred", sort: "ttft" },
      ctx,
    )
    expect(text).toContain("pinned cline-pass/glm-5.2")
    expect(text).toContain("unverifiedChannel")
    expect(runtime.control.readConfig().perModel[MODEL]).toEqual({
      upstreams: ["alibaba", "baseten"],
      exclude: ["deepseek"],
      pinMode: "preferred",
      sort: "ttft",
      capabilities: [],
    })
  })

  it("stores the capability gate and shows the effective one", async () => {
    const { tools: registry, runtime } = await tools()
    const text = await registry.cline_pass_pin.execute(
      { model: "glm-5.2", upstreams: ["alibaba"], capabilities: ["Vision", "tool-use"] },
      ctx,
    )
    expect(text).toContain("capabilities=vision+tool-use")
    expect(runtime.control.readConfig().perModel[MODEL]!.capabilities).toEqual(["vision", "tool-use"])

    // The listing reports the effective gate, not just the stored override.
    const listing = await registry.cline_pass_models.execute({ model: "glm-5.2" }, ctx)
    expect(listing).toContain("gate=vision+tool-use")
  })

  it("hides and shows models through the models tool", async () => {
    const { tools: registry, runtime } = await tools()
    await registry.cline_pass_models.execute({ model: "glm-5.2", visible: false }, ctx)
    expect(runtime.control.readConfig().hiddenModels).toEqual([MODEL])
    const listing = await registry.cline_pass_models.execute({ model: "glm-5.2" }, ctx)
    expect(listing).toContain("hidden from pickers")
    await registry.cline_pass_models.execute({ mode: "all" }, ctx)
    expect(runtime.control.readConfig().hiddenModels).toEqual([])
  })

  it("formats request history", async () => {
    const { tools: registry, runtime } = await tools()
    runtime.store.record({
      model: MODEL,
      provider: "alibaba",
      account: "a",
      ms: 120,
      ttft: 40,
      stream: true,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, reasoningTokens: 2 },
      attempts: ["alibaba"],
      adherence: "adopted",
    })
    const text = await registry.cline_pass_history.execute({ limit: 10 }, ctx)
    expect(text).toContain("cline-pass/glm-5.2 -> alibaba")
    expect(text).toContain("in=10 out=20 cache=3 think=2")
    expect(text).toContain("adherence=adopted")
  })
})
