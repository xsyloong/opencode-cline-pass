import { describe, expect, it } from "vitest"
import { silentLogger } from "../src/log.js"
import type { Runtime } from "../src/runtime.js"
import { createTools } from "../src/tools.js"
import { registerV2, V2_PROVIDER_PACKAGE, type V2Context } from "../src/v2.js"
import { makeRuntime } from "./helpers.js"

const MODEL = "cline-pass/glm-5.2"

async function fakeRuntime(config: Record<string, unknown> = {}): Promise<Runtime> {
  const parts = await makeRuntime({
    config: {
      knownModels: ["cline-pass/glm-5.2", "cline-pass/deepseek-v4.1-flash"],
      ...config,
    },
  })
  const tools = createTools({
    control: parts.control,
    engine: parts.engine,
    store: parts.store,
    logger: silentLogger,
    dashboardUrl: "http://127.0.0.1:12345",
  })
  return {
    ...parts,
    gateway: { url: "http://127.0.0.1:12345", baseURL: "http://127.0.0.1:12345/v1", token: "gateway-token" },
    logger: silentLogger,
    tools,
  } as unknown as Runtime
}

function editor(existing: boolean) {
  const state: {
    added?: any
    updated?: any
    modelsSet?: any[]
    transformed?: number
  } = {}
  return {
    state,
    editor: {
      get() {
        return existing ? { id: "cline-pass" } : undefined
      },
      add(input: any) {
        state.added = input
      },
      update(_id: string, update: (provider: any) => void) {
        const provider: any = {}
        update(provider)
        state.updated = provider
      },
      models: {
        set(_id: string, models: any[]) {
          state.modelsSet = models
        },
      },
    },
  }
}

describe("v2 registration", () => {
  it("adds a provider, its visible models, and the eight tools", async () => {
    const runtime = await fakeRuntime()
    const { editor: target, state } = editor(false)
    const tools: any[] = []
    const ctx: V2Context = {
      location: { directory: runtime.directory },
      provider: {
        async transform(callback) {
          callback(target)
        },
      },
      tool: {
        async transform(callback) {
          callback({ add: (value: any) => tools.push(value) })
        },
      },
    }
    await registerV2(ctx, runtime)

    expect(state.added.info).toMatchObject({
      id: "cline-pass",
      name: "Cline Pass",
      activation: "enabled",
      package: V2_PROVIDER_PACKAGE,
      settings: {
        baseURL: "http://127.0.0.1:12345/v1",
        apiKey: "gateway-token",
        provider: "cline-pass",
      },
    })
    const models = state.added.models
    expect(models).toHaveLength(2)
    const glm = models.find((model: any) => model.id === "glm-5.2")
    expect(glm).toMatchObject({
      modelID: MODEL,
      providerID: "cline-pass",
      name: "GLM-5.2",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 1000000, output: 64000 },
      status: "active",
      enabled: true,
    })
    expect(glm.variants.map((variant: any) => variant.id)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    const reasoningModel = models.find((model: any) => model.id === "deepseek-v4.1-flash")
    expect(reasoningModel.capabilities.input).toEqual(["text", "image"])

    expect(tools).toHaveLength(8)
    const status = tools.find((tool) => tool.name === "cline_pass_status")
    expect(status.input).toMatchObject({ type: "object" })
    expect(status.options).toEqual({ codemode: false })
    const result = await status.execute({}, { signal: new AbortController().signal })
    expect(result.content).toContain('provider "cline-pass"')
  })

  it("updates an existing provider and replaces its model inventory", async () => {
    const runtime = await fakeRuntime({ hiddenModels: ["cline-pass/deepseek-v4.1-flash"] })
    const { editor: target, state } = editor(true)
    const ctx: V2Context = {
      provider: {
        async transform(callback) {
          callback(target)
        },
      },
    }
    await registerV2(ctx, runtime)
    expect(state.updated).toMatchObject({
      id: "cline-pass",
      package: V2_PROVIDER_PACKAGE,
      settings: { baseURL: "http://127.0.0.1:12345/v1" },
    })
    expect(state.modelsSet).toHaveLength(1)
    expect(state.modelsSet[0].id).toBe("glm-5.2")
  })

  it("refreshes the v2 provider when the model inventory changes", async () => {
    const runtime = await fakeRuntime()
    let reloads = 0
    const ctx: V2Context = {
      provider: {
        async transform(callback) {
          callback(editor(false).editor)
        },
        async reload() {
          reloads += 1
        },
      },
    }
    await registerV2(ctx, runtime)
    await runtime.control.refreshModels()
    expect(reloads).toBe(1)
  })

  it("registers an executable /cline-pass command that opens the dashboard", async () => {
    const runtime = await fakeRuntime()
    const commands: any[] = []
    const opened: string[] = []
    const ctx: V2Context = {
      provider: {
        async transform(callback) {
          callback(editor(false).editor)
        },
      },
      command: {
        async transform(callback) {
          callback({ add: (definition: any) => commands.push(definition) })
        },
      },
    }
    await registerV2(ctx, runtime, { openDashboard: (url) => void opened.push(url) })
    const command = commands.find((entry) => entry.name === "cline-pass")
    expect(command).toMatchObject({
      name: "cline-pass",
      description: expect.stringContaining("Open the Cline Pass dashboard"),
    })
    await command.execute({})
    expect(opened).toEqual(["http://127.0.0.1:12345/"])
  })

  it("refuses to open the command when the dashboard is disabled", async () => {
    const runtime = await fakeRuntime({ dashboard: false })
    const commands: any[] = []
    const ctx: V2Context = {
      provider: {
        async transform(callback) {
          callback(editor(false).editor)
        },
      },
      command: {
        async transform(callback) {
          callback({ add: (definition: any) => commands.push(definition) })
        },
      },
    }
    await registerV2(ctx, runtime, { openDashboard: () => {} })
    await expect(commands[0].execute({})).rejects.toThrow(/dashboard is disabled/)
  })

  it("reports a context without provider.transform instead of silently doing nothing", async () => {
    const runtime = await fakeRuntime()
    await expect(registerV2({}, runtime)).rejects.toThrow(/provider\.transform/)
  })
})
