import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import pluginModule, { ClinePassPlugin, ClinePassSetup } from "../src/index.js"
import { dashboardHTML } from "../src/dashboard.js"
import { V2_PROVIDER_PACKAGE } from "../src/v2.js"
import { createRuntime } from "../src/runtime.js"
import { tempDir, TEST_KEY } from "./helpers.js"

const saved = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  CLINE_PASS_SKIP_CATALOG: process.env.CLINE_PASS_SKIP_CATALOG,
  CLINE_PASS_API_KEY: process.env.CLINE_PASS_API_KEY,
}

beforeEach(() => {
  process.env.CLINE_PASS_SKIP_CATALOG = "1"
  process.env.CLINE_PASS_API_KEY = TEST_KEY
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function pluginFor(config: Record<string, unknown> | undefined, directory: string) {
  process.env.XDG_CONFIG_HOME = join(directory, "config")
  if (config !== undefined) {
    await mkdir(join(directory, "config", "opencode"), { recursive: true })
    await writeFile(join(directory, "config", "opencode", "cline-pass.json"), JSON.stringify(config))
  }
  const input = {
    directory,
    worktree: directory,
    project: { id: "test", worktree: directory },
    client: { app: { log: async () => {} } },
    $: undefined,
    serverUrl: new URL("http://localhost:4096"),
  }
  return await ClinePassPlugin(input as any, {})
}

describe("plugin wiring", () => {
  it("injects a complete opencode provider config", async () => {
    const directory = await tempDir()
    const hooks = await pluginFor(undefined, directory)
    try {
      const target: any = { provider: { existing: { npm: "x" } } }
      await hooks.config!(target)
      const provider = target.provider["cline-pass"]
      expect(provider.npm).toBe("@ai-sdk/openai-compatible")
      expect(provider.name).toBe("Cline Pass")
      expect(provider.options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      expect(provider.options.apiKey).toMatch(/^[0-9a-f]{64}$/)
      expect(provider.models["glm-5.2"]).toMatchObject({
        name: "GLM-5.2",
        reasoning: true,
        attachment: false,
        tool_call: true,
        limit: { context: 1000000, output: 64000 },
        modalities: { input: ["text"], output: ["text"] },
      })
      expect(provider.models["glm-5.2"].reasoning_options[0]).toEqual({
        type: "effort",
        values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      })
      expect(Object.keys(provider.models["glm-5.2"].variants)).toHaveLength(7)
      expect(provider.models["deepseek-v4.1-flash"].attachment).toBe(true)
      // Existing provider entries are preserved.
      expect(target.provider.existing).toEqual({ npm: "x" })
      // An existing model is preserved alongside ours.
      target.provider["cline-pass"].models.keep = { name: "keep" }
      await hooks.config!(target)
      expect(target.provider["cline-pass"].models.keep).toEqual({ name: "keep" })
    } finally {
      await hooks.dispose?.()
    }
  })

  it("registers the eight management tools", async () => {
    const directory = await tempDir()
    const hooks = await pluginFor(undefined, directory)
    try {
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(
        [
          "cline_pass_accounts",
          "cline_pass_history",
          "cline_pass_models",
          "cline_pass_pin",
          "cline_pass_probe",
          "cline_pass_status",
          "cline_pass_test",
          "cline_pass_validate",
        ].sort(),
      )
      const status = hooks.tool!.cline_pass_status
      expect(typeof status.execute).toBe("function")
      const text = await status.execute({} as any, {} as any)
      expect(text).toContain('provider "cline-pass"')
      expect(text).toContain("accounts (1)")
      expect(text).toContain("dashboard=http://127.0.0.1:")
      expect(text).not.toContain(TEST_KEY)
    } finally {
      await hooks.dispose?.()
    }
  })

  it("omits the tools when exposeTools is false", async () => {
    const directory = await tempDir()
    const hooks = await pluginFor({ exposeTools: false }, directory)
    try {
      expect(hooks.tool).toBeUndefined()
      const target: any = { provider: {} }
      await hooks.config!(target)
      expect(target.provider["cline-pass"]).toBeDefined()
    } finally {
      await hooks.dispose?.()
    }
  })

  it("hides models from both the model map and the blacklist", async () => {
    const directory = await tempDir()
    const hooks = await pluginFor({ hiddenModels: ["cline-pass/glm-5.2"] }, directory)
    try {
      const target: any = { provider: {} }
      await hooks.config!(target)
      expect(target.provider["cline-pass"].models["glm-5.2"]).toBeUndefined()
      expect(target.provider["cline-pass"].models["glm-5.3"]).toBeDefined()
      expect(target.provider["cline-pass"].blacklist).toEqual(["glm-5.2"])
    } finally {
      await hooks.dispose?.()
    }
  })

  it("honors a custom provider route name", async () => {
    const directory = await tempDir()
    const hooks = await pluginFor({ provider: "my-cline" }, directory)
    try {
      const target: any = { provider: {} }
      await hooks.config!(target)
      expect(target.provider["my-cline"]).toBeDefined()
      expect(target.provider["cline-pass"]).toBeUndefined()
      expect((await hooks.tool!.cline_pass_status.execute({} as any, {} as any))).toContain('"my-cline"')
    } finally {
      await hooks.dispose?.()
    }
  })
})

describe("module shape", () => {
  it("exposes a non-enumerable v1 server and an enumerable v2 setup", () => {
    expect(pluginModule.id).toBe("cline-pass")
    expect(typeof (pluginModule as any).server).toBe("function")
    expect(typeof (pluginModule as any).setup).toBe("function")
    // v1 checks `"server" in value`; v2's schema decoder must not see it.
    expect("server" in pluginModule).toBe(true)
    expect(Object.keys(pluginModule).sort()).toEqual(["id", "setup"])
  })

  it("runs the v2 setup and registers provider plus tools", async () => {
    const directory = await tempDir()
    process.env.XDG_CONFIG_HOME = join(directory, "config")
    const providers: any[] = []
    const tools: any[] = []
    const cleanup = await ClinePassSetup({
      location: { directory },
      provider: {
        async transform(callback) {
          callback({
            get: () => undefined,
            add: (input: any) => providers.push(input),
            update: () => {},
            models: { set: () => {} },
          } as any)
        },
      },
      tool: {
        async transform(callback) {
          callback({ add: (input: any) => tools.push(input) } as any)
        },
      },
    })
    try {
      expect(providers).toHaveLength(1)
      expect(providers[0].info.package).toBe(V2_PROVIDER_PACKAGE)
      expect(providers[0].models.length).toBeGreaterThan(0)
      expect(tools).toHaveLength(8)
    } finally {
      await cleanup()
    }
  })
})

describe("shared runtime", () => {
  it("reuses one gateway per directory and closes it after the last dispose", async () => {
    const directory = await tempDir()
    process.env.XDG_CONFIG_HOME = join(directory, "config")
    const first = await createRuntime({ directory })
    const second = await createRuntime({ directory })
    try {
      expect(second.gateway.url).toBe(first.gateway.url)
      expect(second.store).toBe(first.store)
      await first.dispose()
      const health = await fetch(`${second.gateway.url}/healthz`)
      expect(health.status).toBe(200)
    } finally {
      await second.dispose()
    }
    await expect(fetch(`${first.gateway.url}/healthz`)).rejects.toBeTruthy()
  })
})

describe("dashboard page", () => {
  it("compiles its inline script and embeds the token", () => {
    const html = dashboardHTML("deadbeef", { dashboardUrl: "http://127.0.0.1:1234" })
    expect(html).toContain("const TOKEN = \"deadbeef\"")
    const start = html.lastIndexOf("<script>") + "<script>".length
    const end = html.lastIndexOf("</script>")
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const script = html.slice(start, end)
    expect(() => new Function(script)).not.toThrow()
  })
})
