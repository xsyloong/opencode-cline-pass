import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccountPool } from "../src/pool.js"
import { ConfigStore } from "../src/config.js"
import { createControl, type Control } from "../src/control.js"
import { createEngine, type Engine } from "../src/engine.js"
import { silentLogger } from "../src/log.js"
import { createStore, type ObservationStore } from "../src/store.js"

export const TEST_KEY = "sk_test_default_123456789"

/** A fresh directory with an isolated XDG config home. */
export async function tempDir(prefix = "cline-pass-test-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** Environment that keeps every path and credential inside `directory`. */
export function testEnv(directory: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    CLINE_PASS_API_KEY: TEST_KEY,
    CLINE_PASS_SKIP_CATALOG: "1",
    ...extra,
  }
}

export interface Runtime {
  directory: string
  env: NodeJS.ProcessEnv
  config: ConfigStore
  store: ObservationStore
  pool: AccountPool
  engine: Engine
  control: Control
}

export interface RuntimeOptions {
  config?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  directory?: string
}

/** Write a config file and assemble the same object graph the plugin builds. */
export async function makeRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const directory = options.directory ?? (await tempDir())
  const env = testEnv(directory, options.env)
  if (options.config !== undefined) {
    const path = join(directory, "config", "opencode", "cline-pass.json")
    await mkdir(join(directory, "config", "opencode"), { recursive: true })
    await writeFile(path, JSON.stringify(options.config, null, 2), "utf8")
  }
  const config = await ConfigStore.load({ directory, env })
  const store = createStore({ historyLimit: config.read().historyLimit })
  const pool = new AccountPool({ config: () => config.read(), store: config, logger: silentLogger })
  const engine = createEngine({
    pool,
    store,
    logger: silentLogger,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  const control = createControl({ config, pool, store, engine, logger: silentLogger })
  engine.setPinReader((model) => control.pinFor(model))
  return { directory, env, config, store, pool, engine, control }
}

/** Read a request body from a mocked fetch call. */
export function bodyOf(init: RequestInit | undefined): any {
  if (init?.body === undefined || init.body === null) return undefined
  if (typeof init.body === "string") return JSON.parse(init.body)
  return init.body
}

/** Build an SSE response body from OpenAI chunks. */
export function sse(chunks: unknown[], { done = true }: { done?: boolean } = {}): Response {
  const text =
    chunks.map((chunk) => (chunk === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(chunk)}\n\n`)).join("") +
    (done ? "" : "")
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** A standard streaming answer that reports the channel that served it. */
export function streamAnswer(provider: string, content = "hello"): Response {
  return sse([
    {
      choices: [{ index: 0, delta: { content } }],
      provider_metadata: { gateway: { routing: { finalProvider: provider } } },
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    "[DONE]",
  ])
}
