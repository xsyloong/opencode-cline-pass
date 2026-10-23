import { afterEach, describe, expect, it } from "vitest"
import { silentLogger } from "../src/log.js"
import { startGateway, type ClinePassGateway } from "../src/server.js"
import { bodyOf, makeRuntime, sse, streamAnswer, TEST_KEY, type Runtime } from "./helpers.js"

const MODEL = "cline-pass/glm-5.2"

const accounts = {
  main: { displayName: "Main", apiKeyEnv: "MAIN_KEY", enabled: true, baseURL: "" },
  backup: { displayName: "Backup", apiKeyEnv: "BACKUP_KEY", enabled: true, baseURL: "" },
}
const env = {
  MAIN_KEY: TEST_KEY,
  BACKUP_KEY: "sk_backup_1234567890",
}

const running: ClinePassGateway[] = []

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close()
})

async function boot(
  fetchImpl: typeof fetch,
  config: Record<string, unknown> = {},
): Promise<{ runtime: Runtime; gateway: ClinePassGateway }> {
  const runtime = await makeRuntime({
    config: { knownModels: [MODEL], accounts, activeAccount: "main", ...config },
    env,
    fetchImpl,
  })
  const gateway = await startGateway({
    config: () => runtime.config.read(),
    control: runtime.control,
    pool: runtime.pool,
    engine: runtime.engine,
    store: runtime.store,
    logger: silentLogger,
    fetchImpl,
  })
  running.push(gateway)
  return { runtime, gateway }
}

async function chat(
  gateway: ClinePassGateway,
  body: Record<string, unknown>,
  token = gateway.token,
): Promise<Response> {
  return await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

describe("streaming gateway", () => {
  it("normalizes the bare model key, streams content and records usage", async () => {
    const requests: any[] = []
    const { runtime, gateway } = await boot(async (_url, init) => {
      requests.push({ body: bodyOf(init), auth: new Headers(init?.headers).get("authorization") })
      return streamAnswer("alibaba", "hello")
    })
    const response = await chat(gateway, {
      model: "glm-5.2",
      stream: true,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain('"content":"hello"')
    expect(text).toContain("data: [DONE]")
    expect(requests[0].body.model).toBe(MODEL)
    expect(requests[0].body.reasoning_effort).toBe("high")
    expect(requests[0].body.stream_options).toMatchObject({ include_usage: true })
    expect(requests[0].auth).toBe(`Bearer ${TEST_KEY}`)

    await wait()
    const entry = runtime.store.readHistory(1)[0]!
    expect(entry).toMatchObject({
      model: MODEL,
      provider: "alibaba",
      account: "main",
      stream: true,
      error: null,
      adherence: "unresolved",
      effort: "high",
    })
    expect(entry.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    expect(entry.ttft).toBeGreaterThanOrEqual(0)
  })

  it("serves non-streaming requests", async () => {
    const { gateway } = await boot(async () =>
      Response.json({
        choices: [{ message: { content: "non-stream ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.choices[0].message.content).toBe("non-stream ok")
    expect(json.usage.total_tokens).toBe(5)
  })

  it("fails over to the next pinned channel before the first token", async () => {
    const pins: string[] = []
    const bodies: any[] = []
    const { gateway } = await boot(
      async (_url, init) => {
        const body = bodyOf(init)
        bodies.push(body)
        const only = body.providerOptions?.gateway?.only?.[0] ?? body.provider?.only?.[0]
        pins.push(only)
        if (only === "a") return Response.json({ error: { message: "upstream a refused" } }, { status: 500 })
        return streamAnswer("b", "backup answered")
      },
      { perModel: { [MODEL]: { upstreams: ["a", "b"], pinMode: "strict", exclude: [], sort: "" } } },
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("backup answered")
    expect(pins).toEqual(["a", "b"])
    // Both spellings are written by default, so a pipeline switch cannot make
    // the pin evaporate.
    expect(bodies[0].providerOptions.gateway.only).toEqual(["a"])
    expect(bodies[0].provider.only).toEqual(["a"])
    expect(bodies[1].providerOptions.gateway.only).toEqual(["b"])
    expect(bodies[1].provider.only).toEqual(["b"])
  })

  it("switches to the next account after an authentication refusal", async () => {
    const auths: string[] = []
    const { runtime, gateway } = await boot(async (_url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? ""
      auths.push(auth)
      if (auth.includes(TEST_KEY)) return new Response("", { status: 401 })
      return streamAnswer("b", "backup answered")
    })
    const response = await chat(gateway, {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("backup answered")
    expect(auths).toHaveLength(2)
    expect(auths[0]).toContain(TEST_KEY)
    expect(auths[1]).toContain("sk_backup")
    await wait()
    expect(runtime.store.readHistory(1)[0]?.account).toBe("backup")
    expect(runtime.pool.coolingSnapshot().main).toBeGreaterThan(Date.now())
  })

  it("does not retry after content has reached the caller", async () => {
    let calls = 0
    const { runtime, gateway } = await boot(
      async () => {
        calls += 1
        return sse([
          { choices: [{ index: 0, delta: { content: "partial" } }] },
          { error: { message: "weekly limit reached" } },
          "[DONE]",
        ])
      },
      { perModel: { [MODEL]: { upstreams: ["a", "b"], pinMode: "strict", exclude: [], sort: "" } } },
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("partial")
    expect(text).toContain("weekly limit reached")
    expect(calls).toBe(1)
    await wait()
    const entry = runtime.store.readHistory(1)[0]!
    expect(entry.error).toMatch(/weekly limit/)
    expect(entry.code).toBe("QUOTA")
  })

  it("reports an empty completion instead of returning an empty message", async () => {
    const { runtime, gateway } = await boot(async () =>
      sse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"]),
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(502)
    const json = await response.json()
    expect(json.error.code).toBe("EMPTY_RESPONSE")
    await wait()
    expect(runtime.store.readHistory(1)[0]?.code).toBe("EMPTY_RESPONSE")
  })

  it("learns the serving channel from streaming delta routing metadata", async () => {
    const { runtime, gateway } = await boot(
      async () =>
        sse([
          { choices: [{ index: 0, delta: { content: "pinned answer" } }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  provider_metadata: {
                    gateway: {
                      routing: {
                        finalProvider: "deepseek",
                        canonicalSlug: "deepseek/deepseek-v4.1-flash",
                        affinity: { outcome: "confirmed", pinnedProvider: "deepseek" },
                      },
                    },
                  },
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      { perModel: { [MODEL]: { upstreams: ["deepseek"], pinMode: "strict", exclude: [], sort: "" } } },
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("pinned answer")
    await wait()
    const entry = runtime.store.readHistory(1)[0]!
    expect(entry.provider).toBe("deepseek")
    expect(entry.adherence).toBe("adopted")
    expect(runtime.store.metaOf(MODEL).upstreamStatus?.deepseek?.status).toBe("ok")
  })

  it("records a PIN_DROPPED warning when the router serves a channel it was told not to", async () => {
    // The pin asks for `deepseek`, the answer says `fireworks`: a 200 with the
    // wrong channel is the only symptom of a silently ignored pin.
    const { runtime, gateway } = await boot(
      async () =>
        Response.json({
          choices: [
            {
              message: {
                content: "served elsewhere",
                provider_metadata: { gateway: { routing: { finalProvider: "fireworks" } } },
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      { perModel: { [MODEL]: { upstreams: ["deepseek"], pinMode: "strict", exclude: [], sort: "" } } },
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    await wait()
    const entry = runtime.store.readHistory(1)[0]!
    expect(entry.adherence).toBe("not-adopted")
    expect(entry.provider).toBe("fireworks")
    expect((entry.warnings ?? []).join("\n")).toMatch(/PIN_DROPPED.*fireworks/)
  })

  it("surfaces reasoning_details under a field the AI SDK reads", async () => {
    const { gateway } = await boot(async () =>
      sse([
        { choices: [{ index: 0, delta: { reasoning_details: [{ text: "thinking" }] } }] },
        { choices: [{ index: 0, delta: { content: "answer" } }] },
        "[DONE]",
      ]),
    )
    const response = await chat(gateway, {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    const text = await response.text()
    expect(text).toContain('"reasoning_content":"thinking"')
    expect(text).toContain('"content":"answer"')
  })
})

describe("model aliases", () => {
  const LOCAL = "cline-pass/deepseek-v4.1-flash-1017-open"
  const SLUG = "deepseek/deepseek-v4.1-flash-1017"

  it("puts the aliased open-pool slug on the wire and applies its pin", async () => {
    const bodies: any[] = []
    const { gateway } = await boot(
      async (_url, init) => {
        bodies.push(bodyOf(init))
        return Response.json({
          choices: [
            {
              message: {
                content: "aliased ok",
                provider_metadata: {
                  gateway: { routing: { finalProvider: "deepinfra", fallbacksAvailable: [] } },
                },
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      },
      {
        knownModels: [LOCAL],
        modelAliases: { [LOCAL]: SLUG },
        // The pin is stored under the wire id, which is what the router sees.
        perModel: { [SLUG]: { upstreams: ["deepinfra"], pinMode: "strict", exclude: [], sort: "" } },
      },
    )
    const response = await chat(gateway, {
      model: "deepseek-v4.1-flash-1017-open",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    expect(bodies[0].model).toBe(SLUG)
    expect(bodies[0].providerOptions.gateway.only).toEqual(["deepinfra"])
    const json: any = await response.json()
    expect(json.choices[0].message.content).toBe("aliased ok")
  })
})

describe("gateway access", () => {
  it("requires the process token", async () => {
    const { gateway } = await boot(async () => streamAnswer("alibaba"))
    const response = await chat(gateway, { model: MODEL, stream: true, messages: [] }, "wrong")
    expect(response.status).toBe(401)
  })

  it("publishes OpenAI model metadata", async () => {
    const { gateway } = await boot(async () => streamAnswer("alibaba"))
    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { authorization: `Bearer ${gateway.token}` },
    })
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.data[0]).toMatchObject({
      id: "glm-5.2",
      context_window: 1000000,
      max_output_tokens: 64000,
      capabilities: { reasoning: true, vision: false },
    })
  })

  it("serves the dashboard and its state endpoint only with the token", async () => {
    const { gateway } = await boot(async () => streamAnswer("alibaba"))
    const page = await fetch(`${gateway.url}/`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain("Cline Pass")
    expect(html).toContain("账号池")

    const denied = await fetch(`${gateway.url}/_api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "state" }),
    })
    expect(denied.status).toBe(401)

    const state = await fetch(`${gateway.url}/_api`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cline-pass-token": gateway.token },
      body: JSON.stringify({ action: "state" }),
    })
    expect(state.status).toBe(200)
    const json = await state.json()
    expect(json.ok).toBe(true)
    expect(json.value.provider).toBe("cline-pass")
    expect(json.value.dashboardUrl).toBe(gateway.url)
    expect(json.value.models).toHaveLength(1)
    expect(json.value.accounts[0]).toMatchObject({ key: "main", keyConfigured: true })
    expect(JSON.stringify(json)).not.toContain(TEST_KEY)
  })
})
