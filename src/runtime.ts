/**
 * The object graph shared by the v1 and v2 plugin hosts: config, credential
 * store, account pool, engine, control surface, embedded gateway, and tools.
 */
import { ConfigStore } from "./config.js"
import { createControl, type Control } from "./control.js"
import { createEngine, type Engine } from "./engine.js"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { errorChain } from "./errors.js"
import { createLogger, type Logger } from "./log.js"
import { AccountPool } from "./pool.js"
import { BUILD_TAG } from "./protocol.js"
import { startGateway, type ClinePassGateway } from "./server.js"
import { createStore, type ObservationStore } from "./store.js"
import { createTools } from "./tools.js"
import type { PluginConfig } from "./types.js"

export interface RuntimeOptions {
  directory: string
  fetchImpl?: typeof fetch
}

export interface Runtime {
  directory: string
  config: ConfigStore
  store: ObservationStore
  pool: AccountPool
  engine: Engine
  control: Control
  gateway: ClinePassGateway
  logger: Logger
  cfg: PluginConfig
  tools: ReturnType<typeof createTools> | undefined
  dispose: () => Promise<void>
}

interface SharedRuntime {
  runtime: Runtime
  refs: number
}

/**
 * One gateway/store per directory per process.
 *
 * opencode can invoke a plugin setup more than once for the same location (a
 * reload, or a server and a client path in one process). Starting a fresh
 * gateway for each setup split the provider, dashboard, history, and pin state
 * across different ports. Sharing the runtime keeps one source of truth; a
 * reference count defers the close until the last caller disposes.
 */
const sharedRuntimes = new Map<string, Promise<SharedRuntime>>()

/** Build and start everything the plugin owns. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const key = resolve(options.directory || process.cwd())
  let pending = sharedRuntimes.get(key)
  if (pending === undefined) {
    pending = buildRuntime({ ...options, directory: key }).then((runtime) => ({ runtime, refs: 0 }))
    sharedRuntimes.set(key, pending)
    pending.catch(() => sharedRuntimes.delete(key))
  }
  const shared = await pending
  shared.refs += 1
  let released = false
  return {
    ...shared.runtime,
    dispose: async () => {
      if (released) return
      released = true
      shared.refs -= 1
      if (shared.refs > 0) return
      sharedRuntimes.delete(key)
      await shared.runtime.dispose()
    },
  }
}

async function buildRuntime(options: RuntimeOptions): Promise<Runtime> {
  const directory = options.directory || process.cwd()
  const logger = createLogger("")
  const config = await ConfigStore.load({ directory })
  if (config.loadError !== undefined) {
    logger.error(
      "[cline-pass] configuration could not be read and defaults are in use: %s (fix %s, then restart)",
      config.loadError,
      config.configPath,
    )
  }

  const store = createStore({ historyLimit: config.read().historyLimit })
  const pool = new AccountPool({ config: () => config.read(), store: config, logger })
  const engine = createEngine({
    pool,
    store,
    logger,
    attemptTimeoutMs: 180_000,
    probeTimeoutMs: 60_000,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  const control = createControl({ config, pool, store, engine, logger })
  engine.setPinReader((model) => control.pinFor(model))

  const gateway = await startGateway({
    config: () => config.read(),
    control,
    pool,
    engine,
    store,
    logger,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  const cfg = config.read()
  const tools =
    cfg.exposeTools !== false
      ? createTools({ control, engine, store, logger, dashboardUrl: gateway.url })
      : undefined
  if (tools === undefined) {
    logger.info(
      "[cline-pass] cline_pass_* tools are not exposed (exposeTools: false); the provider and dashboard are unaffected",
    )
  }

  if (cfg.skipCatalogScan === true) {
    logger.info("[cline-pass] startup catalog scan skipped (skipCatalogScan)")
  } else {
    void control
      .refreshCatalog()
      .then((scan) => {
        if (scan.added.length > 0) {
          logger.info(
            "[cline-pass] catalog scan adopted %d new model(s): %s (restart opencode to see them)",
            scan.added.length,
            scan.added.join(", "),
          )
        }
      })
      .catch((error) => {
        logger.warn("[cline-pass] initial catalog scan failed (models stay on the configured list): %s", errorChain(error))
      })
  }

  // The gateway listens on an ephemeral port, so leave a small, non-secret
  // runtime pointer for the dashboard and for humans reading the filesystem.
  const statePath = join(config.paths.globalDir, "cline-pass.runtime.json")
  await writeRuntimeState(statePath, {
    url: gateway.url,
    dashboard: `${gateway.url}/`,
    provider: cfg.provider,
    build: BUILD_TAG,
    pid: process.pid,
    startedAt: Date.now(),
  }).catch((error) => {
    logger.warn("[cline-pass] could not write the runtime pointer %s: %s", statePath, errorChain(error))
  })

  logger.info(
    '[cline-pass] provider route "%s" ready with %d model(s); dashboard %s/ (build %s)',
    cfg.provider,
    control.modelIds().length,
    gateway.url,
    BUILD_TAG,
  )

  return {
    directory,
    config,
    store,
    pool,
    engine,
    control,
    gateway,
    logger,
    cfg,
    tools,
    dispose: async () => {
      await gateway.close()
      await removeRuntimeState(statePath, gateway.url).catch(() => {
        /* the pointer is advisory */
      })
      logger.info("[cline-pass] gateway stopped")
    },
  }
}

interface RuntimeState {
  url: string
  dashboard: string
  provider: string
  build: string
  pid: number
  startedAt: number
}

/** Persist the gateway address, mode 0600, with no credential material. */
async function writeRuntimeState(path: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {
    /* Windows and some filesystems ignore POSIX modes */
  })
}

/** Remove the pointer only when it still names this instance. */
async function removeRuntimeState(path: string, url: string): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (text === undefined) return
  try {
    const parsed = JSON.parse(text) as Partial<RuntimeState>
    if (parsed.url !== url) return
  } catch {
    /* a malformed pointer is still ours to clear */
  }
  await unlink(path).catch(() => {})
}
