import { describe, expect, it } from "vitest"
import { COOLDOWN_MS } from "../src/pool.js"
import { makeRuntime, TEST_KEY } from "./helpers.js"

const accounts = {
  a: { displayName: "A", apiKeyEnv: "KEY_A", enabled: true, baseURL: "" },
  b: { displayName: "B", apiKeyEnv: "KEY_B", enabled: true, baseURL: "" },
}
const env = { KEY_A: TEST_KEY, KEY_B: "sk_b_1234567890" }

describe("account pool", () => {
  it("rotates accounts in round-robin mode and does not advance on a peek", async () => {
    const runtime = await makeRuntime({
      config: { accounts, accountMode: "roundrobin", activeAccount: "" },
      env,
    })
    expect((await runtime.pool.resolveAccount())?.name).toBe("a")
    expect((await runtime.pool.resolveAccount())?.name).toBe("b")
    expect(await runtime.pool.effectiveAccount()).toBe("a")
    expect(await runtime.pool.effectiveAccount()).toBe("a")
    expect((await runtime.pool.resolveAccount())?.name).toBe("a")
  })

  it("uses the selected account in single mode", async () => {
    const runtime = await makeRuntime({
      config: { accounts, accountMode: "single", activeAccount: "b" },
      env,
    })
    expect((await runtime.pool.resolveAccount())?.name).toBe("b")
    expect(await runtime.pool.effectiveAccount()).toBe("b")
  })

  it("skips an account with no key and reports the usable one", async () => {
    const runtime = await makeRuntime({
      config: { accounts, accountMode: "single", activeAccount: "a" },
      env: { KEY_B: "sk_b_1234567890" },
    })
    expect((await runtime.pool.resolveAccount())?.name).toBe("b")
    expect(await runtime.pool.effectiveAccount()).toBe("b")
  })

  it("throws a useful error when every key is missing or disabled", async () => {
    const missing = await makeRuntime({
      config: { accounts, accountMode: "single", activeAccount: "a" },
      env: {},
    })
    await expect(missing.pool.resolveAccount()).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" })

    const disabled = await makeRuntime({
      config: {
        accounts: {
          a: { displayName: "A", apiKeyEnv: "KEY_A", enabled: false, baseURL: "" },
          b: { displayName: "B", apiKeyEnv: "KEY_B", enabled: false, baseURL: "" },
        },
      },
      env,
    })
    await expect(disabled.pool.resolveAccount()).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" })
  })

  it("returns undefined when an exclusion leaves nothing, so the caller can end", async () => {
    const runtime = await makeRuntime({ config: { accounts }, env })
    expect(await runtime.pool.resolveAccount({ exclude: ["a", "b"] })).toBeUndefined()
  })

  it("stands an account down after a quota refusal and restores it when all are cooling", async () => {
    const runtime = await makeRuntime({
      config: { accounts, accountMode: "single", activeAccount: "a" },
      env,
    })
    expect(runtime.pool.markCooling("a", "QUOTA")).toBe(COOLDOWN_MS.QUOTA)
    expect((await runtime.pool.resolveAccount())?.name).toBe("b")
    expect(await runtime.pool.effectiveAccount()).toBe("b")
    runtime.pool.markCooling("b", "AUTH")
    // Every candidate is cooling: the earliest expiry is offered rather than a
    // hard failure, because a window can reset.
    expect((await runtime.pool.resolveAccount())?.name).toBe("a")
    expect(runtime.pool.coolingSnapshot().a).toBeGreaterThan(Date.now())
    expect(runtime.pool.coolingSnapshot().b).toBeGreaterThan(Date.now())
  })

  it("does not cool an account for a transient rate limit", async () => {
    const runtime = await makeRuntime({ config: { accounts }, env })
    expect(runtime.pool.markCooling("a", "RATE_LIMIT")).toBe(0)
    expect(Object.keys(runtime.pool.coolingSnapshot())).toHaveLength(0)
  })

  it("never exposes a full key in account views", async () => {
    const runtime = await makeRuntime({ config: { accounts }, env })
    const views = await runtime.pool.accountsWithKeys()
    expect(views.map((view) => view.key)).toEqual(["a", "b"])
    expect(views[0]).toMatchObject({ keyConfigured: true, keyHint: "sk_tes…6789" })
    expect(JSON.stringify(views)).not.toContain(TEST_KEY)
  })

  it("materializes one implicit default account on a fresh install", async () => {
    const runtime = await makeRuntime({ env: { CLINE_PASS_API_KEY: TEST_KEY } })
    const views = await runtime.pool.accountsWithKeys()
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ key: "default", enabled: true, keyConfigured: true })
    expect((await runtime.pool.resolveAccount())?.name).toBe("default")
  })
})
