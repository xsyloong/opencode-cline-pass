/**
 * The embedded OpenAI-compatible gateway.
 *
 * opencode plugins cannot install an LLM adapter directly, so the plugin starts
 * a loopback HTTP server and registers that server as a `@ai-sdk/openai-
 * compatible` provider. The server owns what the dsh adapter owned: request
 * pinning, the per-account stream slots, pre-first-token failover across
 * channels and accounts, history recording, and the dashboard.
 */
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { createDashboardApi, dashboardHTML } from "./dashboard.js"
import { providerModelKey, wireModelId } from "./catalog.js"
import type { Control } from "./control.js"
import type { Engine } from "./engine.js"
import {
  ABORTED_CODE,
  AUTH_CODE,
  ClinePassError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_REQUEST_CODE,
  MISSING_CREDENTIAL_CODE,
  QUOTA_EXCEEDED_CODE,
  RATE_LIMIT_CODE,
  SERVER_CODE,
  STREAM_CLOSED_CODE,
  TIMEOUT_CODE,
  TRANSPORT_CODE,
  codeForStatus,
  errorChain,
  errorText,
  mapUsage,
} from "./errors.js"
import { chatCompletion, openChatStream } from "./gateway.js"
import type { Logger } from "./log.js"
import type { AccountPool } from "./pool.js"
import {
  BUILD_TAG,
  buildAttempts,
  classifyUpstreamError,
  injectPrefs,
  parseRouting,
  pinAdherence,
  pinWarnings,
  unwrapEnvelope,
} from "./protocol.js"
import { createUpstreamSlots } from "./slots.js"
import type { ObservationStore } from "./store.js"
import {
  IdleWatchdog,
  chunkError,
  chunkHasContent,
  mapFinishReason,
  openAIChunk,
  parseServerSentEvents,
  serializeErrorFrame,
  serializeFrame,
  streamErrorCode,
} from "./stream.js"
import type {
  Attempt,
  PluginConfig,
  ResolvedAccount,
  TraceRow,
  Usage,
} from "./types.js"

const MAX_CHAT_BODY = 64 * 1024 * 1024
const MAX_API_BODY = 2 * 1024 * 1024

export interface GatewayOptions {
  config: () => PluginConfig
  control: Control
  pool: AccountPool
  engine: Engine
  store: ObservationStore
  logger: Logger
  fetchImpl?: typeof fetch
}

interface StreamState {
  headersSent: boolean
  delivered: boolean
  ttfb: number
  ttft: number
  usage: Usage | null
  finishFailure: { message: string; code: string } | null
  observed: { provider: string | null; canonical: string | null; pipeline: "planner" | "direct" | null }
}

function emptyState(): StreamState {
  return {
    headersSent: false,
    delivered: false,
    ttfb: 0,
    ttft: 0,
    usage: null,
    finishFailure: null,
    observed: { provider: null, canonical: null, pipeline: null },
  }
}

/** Map a stable code to the HTTP status the OpenAI client should see. */
function statusFor(code: string, fallback = 502): number {
  switch (code) {
    case QUOTA_EXCEEDED_CODE:
      return 402
    case AUTH_CODE:
    case MISSING_CREDENTIAL_CODE:
    case "INVALID_CREDENTIAL":
      return 401
    case RATE_LIMIT_CODE:
      return 429
    case CONTEXT_WINDOW_EXCEEDED_CODE:
    case INVALID_REQUEST_CODE:
      return 400
    case TIMEOUT_CODE:
      return 504
    case ABORTED_CODE:
      return 499
    case SERVER_CODE:
    case TRANSPORT_CODE:
    case EMPTY_RESPONSE_CODE:
    case STREAM_CLOSED_CODE:
    case "UPSTREAM":
      return 502
    default: {
      const match = /^HTTP_(\d{3})$/.exec(code)
      return match ? Number(match[1]) : fallback
    }
  }
}

function sendJSON(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(value)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, message: string, code = "UPSTREAM"): void {
  sendJSON(res, status, {
    error: { message, type: "cline_pass_error", code, param: null },
  })
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0"
}

/** The embedded gateway. One instance per opencode process. */
export class ClinePassGateway {
  readonly token: string
  port = 0
  host = "127.0.0.1"
  url = ""
  private readonly options: GatewayOptions
  private readonly slots = createUpstreamSlots()
  private dashboard: ReturnType<typeof createDashboardApi> | undefined
  private server: Server | undefined

  constructor(options: GatewayOptions) {
    this.options = options
    this.token = randomBytes(32).toString("hex")
  }

  /** Start listening; falls back to an ephemeral port when the configured one is taken. */
  async start(): Promise<void> {
    const cfg = this.options.config()
    const host = cfg.serverHost || "127.0.0.1"
    const requested = cfg.serverPort ?? 0
    if (requested !== 0) {
      try {
        await this.listenOn(requested, host)
      } catch (error) {
        this.options.logger.warn(
          "[cline-pass] port %d on %s is unavailable (%s); falling back to an ephemeral port",
          requested,
          host,
          errorChain(error),
        )
        await this.listenOn(0, host)
      }
    } else {
      await this.listenOn(0, host)
    }
    const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
    this.url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${this.port}`
    this.dashboard = createDashboardApi({
      control: this.options.control,
      engine: this.options.engine,
      store: this.options.store,
      logger: this.options.logger,
      dashboardUrl: this.url,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    this.options.logger.info(
      "[cline-pass] local gateway %s registered; dashboard %s/ (build %s)",
      this.url,
      this.url,
      BUILD_TAG,
    )
  }

  private listenOn(port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res)
      })
      server.once("error", (error) => {
        try {
          server.close()
        } catch {
          /* never listened */
        }
        reject(error)
      })
      // SSE responses can stay open for minutes; no socket-level timeout.
      server.timeout = 0
      server.requestTimeout = 0
      server.headersTimeout = 60_000
      server.keepAliveTimeout = 65_000
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo | null
        this.port = address && typeof address === "object" ? address.port : 0
        this.host = host
        this.server = server
        resolve()
      })
    })
  }

  /** Stop listening and abort every open connection. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** The base URL an OpenAI-compatible client should use. */
  get baseURL(): string {
    return `${this.url}/v1`
  }

  //#region request dispatch

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.hostAllowed(req)) {
        sendError(res, 403, "this gateway only accepts loopback requests", "FORBIDDEN")
        return
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        // The dashboard carries the management token in its HTML; never serve
        // it to a remote peer even when the gateway itself is bound wider.
        if (!isLoopbackHost(this.hostnameOf(req))) {
          sendError(res, 403, "the dashboard is only served on loopback", "FORBIDDEN")
          return
        }
        this.serveDashboard(res)
        return
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJSON(res, 200, { ok: true, build: BUILD_TAG, provider: this.options.control.providerName })
        return
      }
      if (req.method === "POST" && url.pathname === "/_api") {
        if (!isLoopbackHost(this.hostnameOf(req))) {
          sendError(res, 403, "the dashboard is only served on loopback", "FORBIDDEN")
          return
        }
        await this.handleDashboardApi(req, res)
        return
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!this.authorized(req)) {
          sendError(res, 401, "missing or invalid gateway token", AUTH_CODE)
          return
        }
        this.serveModels(res)
        return
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        if (!this.authorized(req)) {
          sendError(res, 401, "missing or invalid gateway token", AUTH_CODE)
          return
        }
        await this.handleChat(req, res)
        return
      }
      if (req.method === "GET" && url.pathname === "/v1/health") {
        sendJSON(res, 200, { ok: true })
        return
      }
      sendError(res, 404, `no route for ${req.method} ${url.pathname}`, "NOT_FOUND")
    } catch (error) {
      this.options.logger.error("[cline-pass] gateway request failed: %s", errorChain(error))
      if (!res.headersSent) sendError(res, 500, errorChain(error), "GATEWAY")
      else if (!res.writableEnded) res.end()
    }
  }

  private hostnameOf(req: IncomingMessage): string {
    const raw = String(req.headers.host ?? "")
    return raw.startsWith("[") ? raw.slice(1, raw.indexOf("]") === -1 ? undefined : raw.indexOf("]")) : raw.split(":")[0] ?? ""
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const configured = this.options.config().serverHost || "127.0.0.1"
    const loopbackConfigured = configured === "127.0.0.1" || configured === "localhost" || configured === "::1"
    if (loopbackConfigured) return isLoopbackHost(this.hostnameOf(req))
    return true
  }

  private authorized(req: IncomingMessage): boolean {
    const header = String(req.headers.authorization ?? "")
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
    const apiKey = String(req.headers["x-api-key"] ?? "")
    return bearer === this.token || apiKey === this.token
  }

  private serveDashboard(res: ServerResponse): void {
    if (this.options.config().dashboard === false) {
      sendJSON(res, 404, { error: { message: "the dashboard is disabled", code: "DISABLED" } })
      return
    }
    const html = dashboardHTML(this.token, { dashboardUrl: this.url })
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    })
    res.end(html)
  }

  private serveModels(res: ServerResponse): void {
    const connection = this.options.control.connection()
    sendJSON(res, 200, {
      object: "list",
      data: connection.models.map((model) => ({
        id: providerModelKey(model.id),
        object: "model",
        created: 0,
        owned_by: connection.displayName,
        name: model.name,
        context_window: model.context.contextWindow,
        max_output_tokens: model.defaultMaxTokens ?? 0,
        capabilities: {
          reasoning: model.reasoning === true,
          vision: model.inputModalities.includes("image"),
        },
      })),
    })
  }

  private async handleDashboardApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = String(req.headers["x-cline-pass-token"] ?? "")
    if (token !== this.token) {
      sendError(res, 401, "missing or invalid dashboard token", AUTH_CODE)
      return
    }
    // A cross-site form can POST here; a custom header requires a preflight
    // that same-origin policy blocks, and the Origin check is the second belt.
    const origin = req.headers.origin
    if (typeof origin === "string" && origin.length > 0) {
      const expected = `http://${req.headers.host ?? ""}`
      if (
        origin !== expected &&
        origin !== `http://localhost:${this.port}` &&
        origin !== `http://127.0.0.1:${this.port}` &&
        origin !== `http://[::1]:${this.port}`
      ) {
        sendError(res, 403, "cross-origin dashboard request refused", "FORBIDDEN")
        return
      }
    }
    let text: string
    try {
      text = await this.readBody(req, MAX_API_BODY)
    } catch (error) {
      sendError(res, 413, errorChain(error), "PAYLOAD_TOO_LARGE")
      return
    }
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      sendError(res, 400, "the request body is not JSON", INVALID_REQUEST_CODE)
      return
    }
    const action = String(body?.action ?? "")
    const handler = this.dashboard?.[action]
    if (handler === undefined) {
      sendError(res, 404, `unknown dashboard action ${JSON.stringify(action)}`, "NOT_FOUND")
      return
    }
    try {
      const value = await handler(body?.payload ?? {})
      sendJSON(res, 200, { ok: true, value })
    } catch (error) {
      sendJSON(res, 200, {
        ok: false,
        error: { code: "cline-pass/dashboard", message: errorText(error).slice(0, 600), details: {} },
      })
    }
  }

  private async readBody(req: IncomingMessage, limit: number): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += buffer.length
      if (size > limit) throw new Error(`request body exceeds ${limit} bytes`)
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  //#endregion

  //#region chat

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let text: string
    try {
      text = await this.readBody(req, MAX_CHAT_BODY)
    } catch (error) {
      sendError(res, 413, errorChain(error), "PAYLOAD_TOO_LARGE")
      return
    }
    let raw: any
    try {
      raw = JSON.parse(text)
    } catch {
      sendError(res, 400, "the request body is not JSON", INVALID_REQUEST_CODE)
      return
    }
    const model = wireModelId(String(raw?.model ?? ""))
    if (model.length === 0) {
      sendError(res, 400, "the request names no model", INVALID_REQUEST_CODE)
      return
    }
    const stream = raw.stream === true
    const cfg = this.options.config()
    // opencode addresses models by their bare key (`glm-5.2`), while the
    // subscription gateway expects the prefixed wire id (`cline-pass/glm-5.2`).
    const outbound: Record<string, any> = { ...raw, model }
    if (stream) {
      outbound.stream = true
      outbound.stream_options = { ...(raw.stream_options ?? {}), include_usage: true }
    } else {
      outbound.stream = false
      delete outbound.stream_options
    }

    const meta = this.options.store.metaOf(model)
    const pin = this.options.control.pinFor(model)
    const attempts = buildAttempts(pin)
    const trace: TraceRow[] = []
    const refused = new Set<string>()
    let attemptIndex = 0
    let lastError: ClinePassError | null = null
    const startedAt = Date.now()
    const state = emptyState()
    const clientAbort = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) clientAbort.abort(new Error("the client closed the connection"))
    })

    while (attemptIndex < attempts.length) {
      if (clientAbort.signal.aborted) {
        lastError = new ClinePassError("Cline Pass request aborted by caller", ABORTED_CODE)
        break
      }
      const attempt = attempts[attemptIndex++]!
      let account: ResolvedAccount | undefined
      try {
        account = await this.options.pool.resolveAccount({ exclude: [...refused] })
      } catch (error) {
        lastError = error instanceof ClinePassError ? error : new ClinePassError(errorChain(error), TRANSPORT_CODE, { cause: error })
        break
      }
      if (account === undefined) break

      let release: () => void = () => {}
      try {
        release = await this.slots.acquire(account.name, cfg.maxConcurrentRequests, clientAbort.signal)
      } catch (error) {
        if (clientAbort.signal.aborted) {
          lastError = new ClinePassError("Cline Pass request aborted by caller", ABORTED_CODE)
          break
        }
        lastError = new ClinePassError(errorChain(error), TRANSPORT_CODE, { cause: error })
        continue
      }
      const attemptStarted = Date.now()
      const watchdog = new IdleWatchdog(cfg.streamIdleTimeoutMs)
      const signal = AbortSignal.any([clientAbort.signal, watchdog.controller.signal])
      // A failed attempt's partial metrics must not leak into the next one.
      state.usage = null
      state.finishFailure = null
      state.observed = { provider: null, canonical: null, pipeline: null }
      try {
        const pinned = injectPrefs(outbound, meta, attempt)
        if (stream) {
          await this.executeStream({ account, body: pinned, res, signal, watchdog, startedAt, state })
        } else {
          const payload = await this.executeNonStream({ account, body: pinned, signal, state })
          if (clientAbort.signal.aborted) return
          sendJSON(res, 200, payload)
        }
        // Success. A finish_reason of `error` still delivered an answer; it is
        // recorded below rather than retried.
        // `StreamState.observed` uses `provider`, while `pinAdherence` reads a
        // Routing-shaped `finalProvider`. Passing the former directly made every
        // live request look `unresolved` — the pin was sent, but never verified
        // or learned. Hand it the field it actually reads.
        const adherence = pinAdherence(attempt, { finalProvider: state.observed.provider })
        const warnings = pinWarnings(attempt, meta)
        const elapsed = Date.now() - attemptStarted
        trace.push({
          upstream: attempt.upstream ?? "(auto)",
          status: 200,
          ms: elapsed,
          note:
            adherence === "not-adopted" || adherence === "violated"
              ? `pin not adopted: served by ${state.observed.provider ?? "(unknown)"}`
              : "ok",
        })
        const finishFailure = state.finishFailure as { message: string; code: string } | null
        this.options.store.record({
          model,
          provider: state.observed.provider ?? attempt.upstream ?? null,
          canonical: state.observed.canonical,
          attempts: trace.map((row) => row.upstream),
          ms: Date.now() - startedAt,
          ttfb: state.ttfb,
          ttft: state.ttft,
          stream,
          effort: String(raw.reasoning_effort ?? ""),
          usage: state.usage,
          error: finishFailure?.message ?? null,
          code: finishFailure?.code ?? "",
          account: account.name,
          adherence,
          warnings,
        })
        // Only a pin the router actually honored proves the channel works.
        if (finishFailure === null && attempt.upstream !== null && adherence === "adopted") {
          this.options.store.learnUpstream(model, attempt.upstream, "ok", "", elapsed)
        }
        return
      } catch (error) {
        const failure = this.classify(error, watchdog, clientAbort, model, cfg.streamIdleTimeoutMs)
        const elapsed = Date.now() - attemptStarted
        const note = failure.message
        trace.push({
          upstream: attempt.upstream ?? "(auto)",
          status: failure.status ?? (stream ? 200 : 0),
          ms: elapsed,
          note: note.slice(0, 160),
        })
        if (attempt.upstream !== null) {
          this.options.store.learnUpstream(model, attempt.upstream, classifyUpstreamError(note), note, elapsed)
        } else if ((attempt.excludeList ?? []).length > 0) {
          this.options.engine.learnFromError(model, note)
        }
        lastError = failure
        if (state.delivered) {
          // Content already reached the caller: this is the answer's failure,
          // and no retry can un-deliver it. The account is not stood down here:
          // the refusal may be about this answer, not the account's next call.
          this.options.store.record({
            model,
            provider: state.observed.provider ?? attempt.upstream ?? null,
            canonical: state.observed.canonical,
            attempts: trace.map((row) => row.upstream),
            ms: Date.now() - startedAt,
            ttfb: state.ttfb,
            ttft: state.ttft,
            stream,
            error: note.slice(0, 200),
            code: failure.code,
            account: account.name,
          })
          if (!res.writableEnded) {
            res.write(serializeErrorFrame(note, failure.code))
            res.write(serializeFrame("[DONE]"))
            res.end()
          }
          return
        }
        // An account-level refusal is worth another ACCOUNT: that is the whole
        // point of a pool. The full channel chain is retried on the next one.
        if (failure.code === AUTH_CODE || failure.code === QUOTA_EXCEEDED_CODE) {
          refused.add(account.name)
          attemptIndex = 0
          this.options.pool.markCooling(account.name, failure.code)
          this.options.store.record({
            model,
            provider: state.observed.provider,
            canonical: state.observed.canonical,
            attempts: trace.map((row) => row.upstream),
            ms: Date.now() - startedAt,
            ttfb: state.ttfb,
            ttft: state.ttft,
            stream,
            error: failure.message.replace(/\s+/g, " ").trim().slice(0, 200),
            code: failure.code,
            account: account.name,
          })
        }
        continue
      } finally {
        release()
        watchdog.dispose()
      }
    }

    if (clientAbort.signal.aborted && (res.writableEnded || res.destroyed)) return
    const failure =
      lastError ??
      new ClinePassError(
        `no pinned upstream could serve the request [model=${model}]`,
        "UPSTREAM",
      )
    const message = failure.message.includes("[model=") ? failure.message : `${failure.message} [model=${model}]`
    this.options.store.record({
      model,
      provider: null,
      canonical: null,
      attempts: trace.map((row) => row.upstream),
      ms: Date.now() - startedAt,
      ttfb: state.ttfb,
      ttft: state.ttft,
      stream,
      error: message.slice(0, 200),
      code: failure.code,
      account: null,
    })
    if (res.writableEnded || res.destroyed || clientAbort.signal.aborted) return
    if (!res.headersSent) {
      sendError(res, statusFor(failure.code), message, failure.code)
    } else {
      res.write(serializeErrorFrame(message, failure.code))
      res.write(serializeFrame("[DONE]"))
      res.end()
    }
  }

  /** Translate one decoded chunk into a forwarded frame, buffering before the first content. */
  private async executeStream(input: {
    account: ResolvedAccount
    body: Record<string, any>
    res: ServerResponse
    signal: AbortSignal
    watchdog: IdleWatchdog
    startedAt: number
    state: StreamState
  }): Promise<void> {
    const { account, body, res, signal, watchdog, startedAt, state } = input
    const response = await openChatStream({
      baseURL: account.baseURL,
      apiKey: account.key,
      body,
      signal,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    if (!response.ok) throw await this.upstreamError(response)
    if (response.body === null || response.body === undefined) {
      throw new ClinePassError("gateway returned no response body", EMPTY_RESPONSE_CODE, {
        status: response.status,
      })
    }
    const contentType = String(response.headers.get("content-type") ?? "")
    if (!contentType.includes("text/event-stream") && contentType.includes("application/json")) {
      // A 200 JSON body for a streaming request is not a completion stream; if
      // it carries an error, surface that message so failover and history name
      // the real cause instead of "stream ended without [DONE]".
      const raw = await response.text().catch(() => "")
      let detail = raw.slice(0, 400)
      try {
        const parsed = unwrapEnvelope<any>(JSON.parse(raw))
        detail = String(errorText(parsed?.error) || detail)
      } catch {
        /* keep the raw text */
      }
      throw new ClinePassError(
        detail || "gateway returned JSON for a streaming request",
        streamErrorCode(detail, response.status),
        { status: response.status },
      )
    }
    const buffered: string[] = []
    let completed = false
    const responseBody = response.body
    try {
      for await (const payload of parseServerSentEvents(responseBody, {
        touch: () => {
          if (state.ttfb === 0) state.ttfb = Date.now() - startedAt
          watchdog.touch()
        },
        signal,
      })) {
        if (payload === "[DONE]") break
        const chunk = openAIChunk(payload)
        // A 200 response whose body is an error object must fail the attempt, so
        // a pin that the router refuses still fails over to the next candidate.
        const frameError = chunkError(chunk)
        if (frameError !== null) {
          throw new ClinePassError(frameError, streamErrorCode(frameError, 200), { status: 200 })
        }
        // Some gateways stream thinking only under `reasoning_details`; the AI
        // SDK reads `reasoning_content`/`reasoning`, so surface the same text
        // under a field it understands without disturbing the original.
        for (const choice of chunk?.choices ?? []) {
          const delta = choice?.delta
          if (delta === null || delta === undefined) continue
          if (delta.reasoning_content === undefined && delta.reasoning === undefined) {
            const discovered = delta.reasoning_details
            if (Array.isArray(discovered)) {
              const text = discovered
                .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
                .join("")
              if (text.length > 0) delta.reasoning_content = text
            }
          }
        }
        const routing = parseRouting(payload)
        if (routing.finalProvider !== null) {
          state.observed.provider = routing.finalProvider
          state.observed.pipeline = routing.pipeline
          if (routing.canonicalSlug !== null) state.observed.canonical = routing.canonicalSlug
        }
        if (chunk?.usage !== undefined && chunk?.usage !== null) state.usage = mapUsage(chunk.usage)
        for (const choice of chunk?.choices ?? []) {
          if (typeof choice?.finish_reason === "string") {
            const mapped = mapFinishReason(choice.finish_reason)
            if (mapped.failure !== undefined) state.finishFailure = mapped.failure
          }
        }
        const frame = serializeFrame(chunk)
        if (!state.delivered) {
          buffered.push(frame)
          if (chunkHasContent(chunk)) {
            state.ttft = Date.now() - startedAt
            this.writeStreamHead(res)
            for (const held of buffered) res.write(held)
            state.delivered = true
          }
        } else if (!res.writableEnded) {
          res.write(frame)
        }
      }
      completed = true
    } finally {
      if (!completed) {
        // Abandoning a candidate must release its socket before the next one
        // opens; otherwise an early error keeps a stream (and its account slot)
        // busy behind the failover.
        await responseBody.cancel().catch(() => {})
      }
    }
    if (!state.delivered) {
      throw new ClinePassError("model returned a completed response with no content", EMPTY_RESPONSE_CODE)
    }
    if (!res.writableEnded) {
      res.write(serializeFrame("[DONE]"))
      res.end()
    }
  }

  /** One non-streaming attempt. */
  private async executeNonStream(input: {
    account: ResolvedAccount
    body: Record<string, any>
    signal: AbortSignal
    state: StreamState
  }): Promise<any> {
    const { account, body, signal, state } = input
    const result = await chatCompletion({
      baseURL: account.baseURL,
      apiKey: account.key,
      body,
      signal,
      timeoutMs: 180000,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    const payload = unwrapEnvelope<any>(result.json)
    if (!result.ok || (payload?.error !== undefined && payload?.choices === undefined)) {
      const detail = String(errorText(payload?.error) || result.text.slice(0, 400) || `HTTP ${result.status}`)
      throw new ClinePassError(detail, streamErrorCode(detail, result.status), { status: result.status })
    }
    if (!Array.isArray(payload?.choices) || payload.choices.length === 0) {
      throw new ClinePassError("gateway returned no completion", EMPTY_RESPONSE_CODE, { status: result.status })
    }
    const routing = parseRouting(payload)
    state.observed = {
      provider: routing.finalProvider,
      canonical: routing.canonicalSlug,
      pipeline: routing.pipeline,
    }
    state.usage = mapUsage(payload.usage)
    return payload
  }

  private writeStreamHead(res: ServerResponse): void {
    if (res.headersSent) return
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    res.flushHeaders?.()
  }

  private async upstreamError(response: Response): Promise<ClinePassError> {
    const raw = await response.text().catch(() => "")
    let detail = raw.slice(0, 400)
    try {
      const parsed = unwrapEnvelope<any>(JSON.parse(raw))
      detail = String(errorText(parsed?.error) || detail)
    } catch {
      /* keep the raw text */
    }
    const code = streamErrorCode(detail, response.status)
    return new ClinePassError(detail || `HTTP ${response.status}`, code, { status: response.status })
  }

  /** Map a thrown value to one stable failure, honoring abort and idle timeout. */
  private classify(
    error: unknown,
    watchdog: IdleWatchdog,
    clientAbort: AbortController,
    model: string,
    idleMs: number,
  ): ClinePassError {
    if (clientAbort.signal.aborted) {
      return new ClinePassError("Cline Pass request aborted by caller", ABORTED_CODE)
    }
    if (watchdog.timedOut) {
      return new ClinePassError(`Cline Pass stream idle timeout after ${idleMs}ms [model=${model}]`, TIMEOUT_CODE, {
        cause: error,
      })
    }
    if (error instanceof ClinePassError) return error
    if ((error as Error | undefined)?.name === "TimeoutError") {
      return new ClinePassError(`Cline Pass request timed out [model=${model}]`, TIMEOUT_CODE, { cause: error })
    }
    if ((error as Error | undefined)?.name === "AbortError") {
      return new ClinePassError("Cline Pass request aborted by caller", ABORTED_CODE)
    }
    return new ClinePassError(errorChain(error), TRANSPORT_CODE, { cause: error })
  }

  //#endregion
}

/** Create and start the embedded gateway. */
export async function startGateway(options: GatewayOptions): Promise<ClinePassGateway> {
  const gateway = new ClinePassGateway(options)
  await gateway.start()
  return gateway
}
