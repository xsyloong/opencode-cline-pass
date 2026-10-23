import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ConfigStore,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_TOKENS,
  defaultConfig,
  normalizeConfig,
} from "../src/config.js"
import { makeRuntime, tempDir, testEnv } from "./helpers.js"

const ENV_KEY = "sk_env_default_123456789"

describe("configuration", () => {
  it("loads usable defaults on a fresh install", async () => {
    const directory = await tempDir()
    const config = await ConfigStore.load({ directory, env: testEnv(directory) })
    const cfg = config.read()
    expect(cfg.provider).toBe("cline-pass")
    expect(cfg.baseURL).toBe("https://api.cline.bot/api/v1")
    expect(cfg.accountMode).toBe("single")
    expect(cfg.knownModels).toHaveLength(19)
    expect(cfg.modelAliases["cline-pass/deepseek-v4.1-flash-1017-open"]).toBe(
      "deepseek/deepseek-v4.1-flash-1017",
    )
    // One alias per VMC-locked model, and none for the model that pins already.
    expect(cfg.modelAliases["cline-pass/glm-5.3-open"]).toBe("z-ai/glm-5.3")
    expect(cfg.modelAliases["cline-pass/kimi-k3-open"]).toBe("moonshotai/kimi-k3")
    expect(cfg.modelAliases["cline-pass/deepseek-v4-pro-open"]).toBeUndefined()
    // A model whose slug also drops pins gets no alias at all.
    expect(cfg.modelAliases["cline-pass/deepseek-v4.1-flash-open"]).toBeUndefined()
    expect(cfg.defaultMaxTokens).toBe(DEFAULT_MAX_TOKENS)
    expect(cfg.maxConcurrentRequests).toBe(DEFAULT_MAX_CONCURRENT_REQUESTS)
    expect(cfg.pinSpelling).toBe("both")
    expect(cfg.exposeTools).toBe(true)
    expect(cfg.skipCatalogScan).toBe(true)
    expect(await config.resolveCredential("CLINE_PASS_API_KEY")).toBeTruthy()
  })

  it("ships the capability gate and lets one model override it", () => {
    expect(defaultConfig().pinCapabilities).toEqual(["vision"])
    expect(normalizeConfig({}).pinCapabilities).toEqual(["vision"])

    expect(normalizeConfig({ pinCapabilities: [" Tool-Use ", "vision", "vision"] }).pinCapabilities).toEqual([
      "tool-use",
      "vision",
    ])
    // An explicit empty list turns the gate off; that is a real setting, not a
    // fallback, because on a VMC id it makes pins inert.
    expect(normalizeConfig({ pinCapabilities: [] }).pinCapabilities).toEqual([])

    const perModel = normalizeConfig({
      perModel: { "cline-pass/x": { upstreams: ["a"], capabilities: ["implicit-caching"] } },
    })
    expect(perModel.perModel["cline-pass/x"]!.capabilities).toEqual(["implicit-caching"])
    // Unset stays empty so `pinFor` can inherit the route-wide gate.
    expect(normalizeConfig({ perModel: { "cline-pass/x": { upstreams: ["a"] } } }).perModel["cline-pass/x"]!.capabilities).toEqual([])
  })

  it("persists a patch and reloads it", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    const config = await ConfigStore.load({ directory, env })
    await config.update({ accountMode: "roundrobin", activeAccount: "main" })
    const reloaded = await ConfigStore.load({ directory, env })
    expect(reloaded.read().accountMode).toBe("roundrobin")
    expect(reloaded.read().activeAccount).toBe("main")
    const raw = JSON.parse(await readFile(config.configPath, "utf8"))
    expect(raw.accountMode).toBe("roundrobin")
  })

  it("removes keys that a patch omits", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    const config = await ConfigStore.load({ directory, env })
    await config.update({
      accounts: {
        keep: { displayName: "keep", apiKeyEnv: "KEEP", enabled: true, baseURL: "" },
        drop: { displayName: "drop", apiKeyEnv: "DROP", enabled: true, baseURL: "" },
      },
    })
    await config.update(
      {
        accounts: { keep: { displayName: "keep", apiKeyEnv: "KEEP", enabled: true, baseURL: "" } },
        activeAccount: "",
      },
      [["accounts", "drop"]],
    )
    expect(Object.keys(config.read().accounts)).toEqual(["keep"])
    const reloaded = await ConfigStore.load({ directory, env })
    expect(Object.keys(reloaded.read().accounts)).toEqual(["keep"])
  })

  it("prefers a stored key over the environment and masks hints", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    const config = await ConfigStore.load({ directory, env })
    expect(await config.resolveCredential("CLINE_PASS_API_KEY")).toBe(env.CLINE_PASS_API_KEY)
    await config.setCredential("CLINE_PASS_API_KEY", "sk_stored_abcdefghijklmnop")
    expect(await config.resolveCredential("CLINE_PASS_API_KEY")).toBe("sk_stored_abcdefghijklmnop")
    expect(await config.credentialHint("CLINE_PASS_API_KEY")).toBe("sk_sto…mnop")
    expect(await config.hasCredential("MISSING")).toBe(false)

    if (process.platform !== "win32") {
      const mode = (await stat(config.credentialsPath)).mode & 0o777
      expect(mode).toBe(0o600)
    }
    const raw = JSON.parse(await readFile(config.credentialsPath, "utf8"))
    expect(raw.CLINE_PASS_API_KEY).toBe("sk_stored_abcdefghijklmnop")
  })

  it("overlays project configuration and writes back to the project file", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    await mkdir(join(directory, "config", "opencode"), { recursive: true })
    await writeFile(
      join(directory, "config", "opencode", "cline-pass.json"),
      JSON.stringify({ accountMode: "roundrobin", displayName: "Global" }),
    )
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(
      join(directory, ".opencode", "cline-pass.json"),
      JSON.stringify({ displayName: "Project", accountMode: "single" }),
    )
    const config = await ConfigStore.load({ directory, env })
    expect(config.read().displayName).toBe("Project")
    expect(config.read().accountMode).toBe("single")
    expect(config.configPath).toBe(join(directory, ".opencode", "cline-pass.json"))
    await config.update({ displayName: "Edited" })
    const project = JSON.parse(await readFile(join(directory, ".opencode", "cline-pass.json"), "utf8"))
    expect(project.displayName).toBe("Edited")
  })

  it("surfaces a broken file but keeps defaults", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    await mkdir(join(directory, "config", "opencode"), { recursive: true })
    await writeFile(join(directory, "config", "opencode", "cline-pass.json"), "{ not json")
    const config = await ConfigStore.load({ directory, env })
    expect(config.loadError).toMatch(/not valid JSON/)
    expect(config.read().provider).toBe("cline-pass")
  })

  it("clamps invalid numbers and enums", () => {
    const cfg = normalizeConfig({
      accountMode: "nonsense",
      defaultMaxTokens: -1,
      defaultContextWindow: 0,
      maxConcurrentRequests: 0,
      historyLimit: 0,
      pinSpelling: "detected",
      serverPort: 99999,
    })
    expect(cfg.accountMode).toBe("single")
    expect(cfg.defaultMaxTokens).toBe(DEFAULT_MAX_TOKENS)
    expect(cfg.defaultContextWindow).toBe(128000)
    expect(cfg.maxConcurrentRequests).toBe(0)
    expect(cfg.historyLimit).toBe(100)
    expect(cfg.pinSpelling).toBe("detected")
    expect(cfg.serverPort).toBe(65535)
  })

  it("exposes the defaults the tools advertise", () => {
    expect(defaultConfig().exposeTools).toBe(true)
    expect(defaultConfig().knownModels).toHaveLength(19)
  })

  it("merges account dictionaries instead of replacing them", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    await mkdir(join(directory, "config", "opencode"), { recursive: true })
    await writeFile(
      join(directory, "config", "opencode", "cline-pass.json"),
      JSON.stringify({ accounts: { a: { displayName: "A", apiKeyEnv: "A", enabled: true, baseURL: "" } } }),
    )
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(
      join(directory, ".opencode", "cline-pass.json"),
      JSON.stringify({ accounts: { b: { displayName: "B", apiKeyEnv: "B", enabled: true, baseURL: "" } } }),
    )
    const config = await ConfigStore.load({ directory, env })
    expect(Object.keys(config.read().accounts).sort()).toEqual(["a", "b"])
  })

  it("keeps an unusual account name untouched", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    const config = await ConfigStore.load({ directory, env })
    await config.update({
      accounts: { "foo.bar": { displayName: "Foo", apiKeyEnv: "FOO", enabled: true, baseURL: "" } },
    })
    expect(config.read().accounts["foo.bar"]?.apiKeyEnv).toBe("FOO")
  })

  it("does not lose a pin written by another client", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    const first = await ConfigStore.load({ directory, env })
    const second = await ConfigStore.load({ directory, env })
    const pin = { upstreams: ["alibaba"], exclude: ["deepseek"], pinMode: "preferred", sort: "ttft", capabilities: [] }
    await first.update({ perModel: { "cline-pass/glm-5.2": pin } })
    // `second` loaded before the pin. Its stale snapshot must not erase it when
    // it refreshes the catalog.
    await second.update({ knownModels: ["cline-pass/glm-5.2"] })
    const reloaded = await ConfigStore.load({ directory, env })
    expect(reloaded.read().perModel["cline-pass/glm-5.2"]).toEqual(pin)
  })

  it("notices a pin written by another client after it loaded", async () => {
    const directory = await tempDir()
    const env = testEnv(directory)
    const first = await ConfigStore.load({ directory, env })
    const second = await ConfigStore.load({ directory, env })
    const pin = { upstreams: ["fireworks"], exclude: [], pinMode: "preferred", sort: "ttft", capabilities: [] }
    await first.update({ perModel: { "cline-pass/glm-5.2": pin } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(second.read().perModel["cline-pass/glm-5.2"]).toEqual(pin)
  })

  it("is usable through the runtime helper", async () => {
    const runtime = await makeRuntime({ config: { accountMode: "roundrobin" } })
    expect(runtime.control.readConfig().accountMode).toBe("roundrobin")
    expect(await runtime.control.effectiveAccount()).toBe("default")
  })
})
