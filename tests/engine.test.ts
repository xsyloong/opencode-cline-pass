import { describe, expect, it } from "vitest"
import { pinWarnings } from "../src/protocol.js"
import { bodyOf, makeRuntime, TEST_KEY } from "./helpers.js"

const MODEL = "cline-pass/glm-5.2"

const accounts = {
  main: { displayName: "Main", apiKeyEnv: "MAIN_KEY", enabled: true, baseURL: "" },
  backup: { displayName: "Backup", apiKeyEnv: "BACKUP_KEY", enabled: true, baseURL: "" },
}
const env = {
  MAIN_KEY: TEST_KEY,
  BACKUP_KEY: "sk_backup_1234567890",
}

function plannerProbeFetch(requests: any[]): typeof fetch {
  return async (url, init) => {
    const body = bodyOf(init)
    requests.push({ url: String(url), body })
    if (body?.providerOptions?.gateway?.only?.[0] === "__probe__") {
      return Response.json(
        { error: { message: "No providers available. Available providers are: alibaba, baseten." } },
        { status: 400 },
      )
    }
    if (body?.provider?.only?.[0] === "__probe__") {
      return Response.json(
        {
          error: {
            message: JSON.stringify({ error: { metadata: { available_providers: ["z-ai", "gmicloud"] } } }),
          },
        },
        { status: 400 },
      )
    }
    return Response.json({
      model: "z-ai/glm-5.2",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [
        {
          message: {
            content: "OK",
            provider_metadata: {
              gateway: {
                routing: {
                  finalProvider: "alibaba",
                  canonicalSlug: "z-ai/glm-5.2",
                  planningReasoning: "alibaba won tier 0 over baseten",
                },
              },
            },
          },
        },
      ],
    })
  }
}

describe("probe", () => {
  it("detects the pipeline, harvests both channel lists and translates the serving channel", async () => {
    const requests: any[] = []
    const runtime = await makeRuntime({
      config: { knownModels: [MODEL], accounts, activeAccount: "main" },
      env,
      fetchImpl: plannerProbeFetch(requests),
    })
    const result = await runtime.engine.probe(MODEL)
    expect(result.ok).toBe(true)
    expect(result.pipeline).toBe("planner")
    expect(result.pinnable).toBe(true)
    expect(result.lastProvider).toBe("alibaba")
    expect(result.canonicalSlug).toBe("z-ai/glm-5.2")
    expect(result.upstreams).toEqual(["alibaba", "baseten", "z-ai", "gmicloud"])
    expect(result.availableProviders).toEqual(["alibaba", "baseten"])
    expect(result.tier0).toEqual(["alibaba", "baseten"])
    expect(requests).toHaveLength(3)
    const meta = runtime.store.metaOf(MODEL)
    expect(meta.channels?.planner).toEqual(["alibaba", "baseten"])
    expect(meta.channels?.direct).toEqual(["z-ai", "gmicloud"])
    expect(meta.upstreamDetail).toEqual({})
    expect(meta.probedAt).toBeGreaterThan(0)
  })

  it("preserves a known pipeline when the probe fails", async () => {
    const runtime = await makeRuntime({
      config: { knownModels: [MODEL], accounts, activeAccount: "main" },
      env,
      fetchImpl: async () => Response.json({ error: { message: "boom" } }, { status: 500 }),
    })
    runtime.store.learn(MODEL, { pipeline: "planner", upstreams: ["alibaba"] })
    const result = await runtime.engine.probe(MODEL)
    expect(result.ok).toBe(false)
    expect(runtime.store.metaOf(MODEL).pipeline).toBe("planner")
    expect(runtime.store.metaOf(MODEL).upstreams).toEqual(["alibaba"])
  })
})

describe("virtual model routes", () => {
  const VMC = "cline-pass/deepseek-v4.1-flash-1017"

  function vmcFetch(requests: any[]): typeof fetch {
    return async (url, init) => {
      const body = bodyOf(init)
      requests.push({ url: String(url), body })
      return Response.json({
        model: "vmc/deepseek-v4p1-flash-1017-contributor-fallbacks",
        choices: [
          {
            message: {
              content: "OK",
              provider_metadata: {
                gateway: {
                  virtualModelConfig: { modelId: "deepseek-v4p1-flash-1017-contributor-fallbacks" },
                  routing: {
                    finalProvider: "openai-compatible-private",
                    canonicalSlug: "private/deepseek-v4p1-flash-1017-contributor",
                    fallbacksAvailable: [],
                    planningReasoning:
                      "System credentials planned for: openai-compatible-private. Total execution order: openai-compatible-private(system)",
                  },
                },
              },
            },
          },
        ],
      })
    }
  }

  it("treats a VMC route as pinnable once the capability-gated probe reaches the router", async () => {
    const requests: any[] = []
    const runtime = await makeRuntime({
      config: { knownModels: [VMC], accounts, activeAccount: "main" },
      env,
      fetchImpl: async (url, init) => {
        const body = bodyOf(init)
        requests.push(body)
        // Only the gated impossible pin is refused. The plain probe (and the
        // direct spelling) still gets a normal completion, which is exactly what
        // the VMC path does on the wire.
        if (
          body?.providerOptions?.gateway?.only?.[0] === "__probe__" &&
          Array.isArray(body?.providerOptions?.gateway?.has) &&
          body.providerOptions.gateway.has.length > 0
        ) {
          return Response.json(
            {
              error: {
                message:
                  "No available providers match the 'only' filter: __probe__. Available providers are: alibaba, baseten, deepseek.",
              },
            },
            { status: 400 },
          )
        }
        return vmcFetch([])(url, init)
      },
    })
    const result = await runtime.engine.probe(VMC)
    expect(result.ok).toBe(true)
    expect(result.pipeline).toBe("planner")
    // The VMC defaults to one private channel, but the gate reaches the router.
    expect(result.pinnable).toBe(true)
    expect(result.pinInert).toBe(false)
    expect(result.capabilityGated).toBe(true)
    expect(result.virtualModel).toBe("deepseek-v4p1-flash-1017-contributor-fallbacks")
    expect(result.availableProviders).toEqual(["alibaba", "baseten", "deepseek"])
    expect(result.upstreams).toContain("alibaba")
    // The gate rode along on the planner harvest; the direct spelling has none.
    const gated = requests.filter((body) => body?.providerOptions?.gateway?.only?.[0] === "__probe__")
    expect(gated).toHaveLength(1)
    expect(gated[0].providerOptions.gateway.has).toEqual(["vision"])
    expect(runtime.store.metaOf(VMC).capabilityGated).toBe(true)
  })

  it("keeps a VMC route inert when even the gated probe is answered", async () => {
    const requests: any[] = []
    const runtime = await makeRuntime({
      config: { knownModels: [VMC], accounts, activeAccount: "main" },
      env,
      fetchImpl: vmcFetch(requests),
    })
    const result = await runtime.engine.probe(VMC)
    expect(result.ok).toBe(true)
    expect(result.pipeline).toBe("planner")
    // This fake route ignores providerOptions entirely, gate included.
    expect(result.pinnable).toBe(false)
    expect(result.pinInert).toBe(true)
    expect(result.virtualModel).toBe("deepseek-v4p1-flash-1017-contributor-fallbacks")
    expect(result.upstreams).toEqual(["openai-compatible-private"])
    expect(result.warning).toMatch(/VMC/)
    expect(requests.length).toBeGreaterThan(1)
    expect(runtime.store.metaOf(VMC).pinInert).toBe(true)
  })

  it("probes without the gate when the gate is switched off", async () => {
    // An explicit empty `pinCapabilities` is a decision, so the probe must test
    // the request that will really be sent — not a defaulted one.
    const requests: any[] = []
    const runtime = await makeRuntime({
      config: { knownModels: [VMC], pinCapabilities: [], accounts, activeAccount: "main" },
      env,
      fetchImpl: vmcFetch(requests),
    })
    const result = await runtime.engine.probe(VMC)
    expect(result.pinInert).toBe(true)
    const gated = requests.filter((entry) => entry.body?.providerOptions?.gateway?.only?.[0] === "__probe__")
    expect(gated).toHaveLength(1)
    expect(gated[0].body.providerOptions.gateway.has).toBeUndefined()
  })

  it("treats a route that answers an impossible pin as unpinnable, VMC or not", async () => {
    // The regression: `deepseek/deepseek-v4.1-flash` returns no
    // `virtualModelConfig` at all, but silently ignores every `only`. Reading
    // only the VMC field marked it pinnable and offered a pin that never applied.
    const SLUG = "deepseek/deepseek-v4.1-flash"
    const requests: any[] = []
    const runtime = await makeRuntime({
      config: { knownModels: [SLUG], accounts, activeAccount: "main" },
      env,
      fetchImpl: async (_url, init) => {
        const body = bodyOf(init)
        requests.push(body)
        // An ordinary completion, no matter what `only` was asked for.
        return Response.json({
          model: SLUG,
          choices: [
            {
              message: {
                content: "OK",
                provider_metadata: {
                  gateway: {
                    routing: {
                      finalProvider: "alibaba",
                      fallbacksAvailable: ["deepseek", "baseten"],
                      planningReasoning:
                        "System credentials planned for: alibaba, deepseek, baseten. Total execution order: alibaba(system) → deepseek(system)",
                    },
                  },
                },
              },
            },
          ],
        })
      },
    })
    const result = await runtime.engine.probe(SLUG)
    expect(result.ok).toBe(true)
    // The impossible `only` was answered instead of refused.
    expect(requests.some((body) => body?.providerOptions?.gateway?.only?.[0] === "__probe__")).toBe(true)
    expect(result.pinnable).toBe(false)
    expect(result.pinInert).toBe(true)
    expect(result.virtualModel).toBe("")
    expect(result.warning).toMatch(/impossible pin/)
  })

  it("warns that a pin is inert instead of silently reporting it unused", async () => {
    const runtime = await makeRuntime({
      config: { knownModels: [VMC], accounts, activeAccount: "main" },
      env,
      fetchImpl: vmcFetch([]),
    })
    runtime.store.learn(VMC, { pipeline: "planner", pinInert: true, virtualModel: "some-vmc" })
    const warnings = pinWarnings({ upstream: "alibaba" }, runtime.store.metaOf(VMC))
    expect(warnings[0]).toMatch(/PIN_INERT/)
  })
})

describe("validate", () => {
  it("reports a verdict per channel and never marks an unreported channel available", async () => {
    const runtime = await makeRuntime({
      config: { knownModels: [MODEL], accounts, activeAccount: "main" },
      env,
      fetchImpl: async (_url, init) => {
        const body = bodyOf(init)
        const only = body?.providerOptions?.gateway?.only?.[0] ?? body?.provider?.only?.[0]
        if (only === "alibaba") {
          return Response.json({
            choices: [
              {
                message: {
                  content: "hi",
                  provider_metadata: { gateway: { routing: { finalProvider: "alibaba" } } },
                },
              },
            ],
          })
        }
        if (only === "baseten") {
          return Response.json({ error: { message: "429 Too Many Requests" } }, { status: 429 })
        }
        if (only === "broken") {
          return Response.json({
            choices: [{ message: { content: "hi", provider_metadata: { gateway: { routing: { finalProvider: "deepseek" } } } } }],
          })
        }
        return Response.json({ choices: [{ message: { content: "hi" } }] })
      },
    })
    runtime.store.learn(MODEL, { upstreams: ["alibaba", "baseten", "broken", "silent"] })
    const outcome = await runtime.engine.validate(MODEL)
    expect(outcome.summary).toEqual({ ok: 1, limited: 1, bad: 1, auth: 0, unknown: 1 })
    const byName = new Map(outcome.results.map((row) => [row.upstream, row.status]))
    expect(byName.get("alibaba")).toBe("ok")
    expect(byName.get("baseten")).toBe("limited")
    expect(byName.get("broken")).toBe("not-adopted")
    expect(byName.get("silent")).toBe("unknown")
    expect(runtime.store.metaOf(MODEL).upstreamStatus?.silent?.status).toBe("unknown")
    expect(runtime.store.metaOf(MODEL).validatedAt).toBeGreaterThan(0)
  })
})

describe("pinned test", () => {
  it("walks the channel chain and reports the channel that really served it", async () => {
    const requests: any[] = []
    const runtime = await makeRuntime({
      config: { knownModels: [MODEL], accounts, activeAccount: "main", perModel: { [MODEL]: { upstreams: ["a", "b"], pinMode: "strict", exclude: [], sort: "" } } },
      env,
      fetchImpl: async (_url, init) => {
        const body = bodyOf(init)
        requests.push(body)
        const only = body?.providerOptions?.gateway?.only?.[0] ?? body?.provider?.only?.[0]
        if (only === "a") {
          return Response.json({ error: { message: "upstream a refused the pin" } }, { status: 400 })
        }
        return Response.json({
          choices: [
            {
              message: {
                content: "OK",
                provider_metadata: { gateway: { routing: { finalProvider: "b", planningReasoning: "b won" } } },
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })
      },
    })
    const result = await runtime.engine.test(MODEL)
    expect(result.ok).toBe(true)
    expect(result.actual).toBe("b")
    expect(result.adopted).toBe(true)
    expect(result.adherence).toBe("adopted")
    expect(result.trace.map((row) => row.upstream)).toEqual(["a", "b"])
    expect(requests).toHaveLength(2)
    expect(requests[0].providerOptions.gateway.only).toEqual(["a"])
    expect(requests[1].providerOptions.gateway.only).toEqual(["b"])
    const history = runtime.store.readHistory(10)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ model: MODEL, provider: "b", account: "main", stream: false, adherence: "adopted" })
    expect(history[0]?.attempts).toEqual(["a", "b"])
    expect(runtime.store.metaOf(MODEL).upstreamStatus?.b?.status).toBe("ok")
  })

  it("fails when the gateway ignores the pin", async () => {
    const runtime = await makeRuntime({
      config: { knownModels: [MODEL], accounts, activeAccount: "main", perModel: { [MODEL]: { upstreams: ["a"], pinMode: "strict", exclude: [], sort: "" } } },
      env,
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: "OK", provider_metadata: { gateway: { routing: { finalProvider: "other" } } } } }],
        }),
    })
    const result = await runtime.engine.test(MODEL)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/gateway ignored the pin/)
    expect(result.actual).toBe("other")
  })
})

describe("account testing", () => {
  it("distinguishes a bad key from a model-specific refusal", async () => {
    let responder: () => Response = () => Response.json({ choices: [{ message: { content: "OK" } }] })
    const runtime = await makeRuntime({
      config: { knownModels: [MODEL], accounts, activeAccount: "main" },
      env,
      fetchImpl: async () => responder(),
    })
    const call = () => runtime.engine.testAccount({ key: TEST_KEY, baseURL: "http://gateway.invalid/api/v1", model: MODEL })

    expect((await call()).authorized).toBe(true)

    responder = () => Response.json({ error: { message: "unauthorized" } }, { status: 401 })
    expect((await call()).authorized).toBe(false)

    responder = () => Response.json({ error: { message: "unsupported model" } }, { status: 400 })
    expect((await call()).authorized).toBe(true)

    responder = () => Response.json({ error: { message: "weekly limit exhausted" } }, { status: 402 })
    expect((await call()).authorized).toBe(true)

    responder = () => new Response("<html>bad gateway</html>", { status: 500 })
    expect((await call()).authorized).toBe(false)

    responder = () => Response.json({})
    expect((await call()).authorized).toBe(false)
  })
})

describe("pin reader", () => {
  it("returns the stored pin plus the route-wide spelling", async () => {
    const runtime = await makeRuntime({
      config: {
        knownModels: [MODEL],
        pinSpelling: "detected",
        perModel: { [MODEL]: { upstreams: ["a"], exclude: ["b"], pinMode: "preferred", sort: "cost" } },
      },
      env,
    })
    expect(runtime.engine.currentPin(MODEL)).toEqual({
      upstreams: ["a"],
      exclude: ["b"],
      pinMode: "preferred",
      sort: "cost",
      spelling: "detected",
      capabilities: ["vision"],
    })
    expect(runtime.engine.currentPin(MODEL, { upstreams: ["c"] })).toMatchObject({
      upstreams: ["c"],
      exclude: ["b"],
    })
  })
})
