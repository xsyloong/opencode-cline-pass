/**
 * SSE decoding and stream-frame helpers shared by the proxy and the engine.
 */
import { ClinePassError, STREAM_CLOSED_CODE, codeForStatus, errorText } from "./errors.js"
import { reasoningOf, unwrapEnvelope } from "./protocol.js"

/** One decoded frame, or the terminal sentinel. */
export type SSEPayload = any | "[DONE]"

export interface ParseOptions {
  /** Called whenever bytes arrive, so an idle watchdog can be reset. */
  touch?: () => void
  signal?: AbortSignal
}

/**
 * Parse an SSE body into decoded JSON frames.
 *
 * Comments and non-`data:` lines are ignored. An unparseable frame carries
 * nothing to deliver, so it is dropped rather than failing the stream. A stream
 * that ends without `[DONE]` is an error: the caller cannot know the answer was
 * complete.
 */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: ParseOptions = {},
): AsyncGenerator<SSEPayload, void, unknown> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const bytes of body as AsyncIterable<Uint8Array>) {
    options.touch?.()
    buffer += decoder.decode(bytes, { stream: true })
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
      if (line.length === 0 || line.startsWith(":")) continue
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") {
        yield "[DONE]"
        return
      }
      if (payload.length === 0) continue
      try {
        yield JSON.parse(payload)
      } catch {
        /* an unparseable frame carries nothing to deliver */
      }
    }
  }
  options.touch?.()
  const tail = buffer.trim()
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim()
    if (payload === "[DONE]") {
      yield "[DONE]"
      return
    }
    if (payload.length > 0) {
      try {
        yield JSON.parse(payload)
      } catch {
        /* see above */
      }
    }
  }
  throw new ClinePassError("stream ended without [DONE]", STREAM_CLOSED_CODE)
}

/** Serialize one payload as an SSE frame. */
export function serializeFrame(payload: unknown | "[DONE]"): string {
  if (payload === "[DONE]") return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Serialize an error as an OpenAI-shaped SSE error frame. */
export function serializeErrorFrame(message: string, code = "UPSTREAM"): string {
  return serializeFrame({ error: { message, type: "cline_pass_error", code, param: null } })
}

/** Map an OpenAI `finish_reason` to a normalized reason. */
export function mapFinishReason(reason: unknown): { kind: string; failure?: { message: string; code: string } } {
  switch (reason) {
    case "stop":
    case "end_turn":
      return { kind: "stop" }
    case "tool_calls":
    case "tool-calls":
      return { kind: "tool-calls" }
    case "length":
    case "max_tokens":
      return { kind: "max-tokens" }
    default:
      return {
        kind: "error",
        failure: { message: `model stopped: ${String(reason)}`, code: String(reason).toUpperCase() },
      }
  }
}

/** Map a gateway error payload to a stable code. */
export function streamErrorCode(message: unknown, status?: number): string {
  return codeForStatus(status, errorText(message))
}

/**
 * Whether one decoded chunk carries content the caller would see.
 *
 * Reasoning counts: a stream that produced thinking but no text still delivered
 * something, and failing it over would replay the thought.
 */
export function chunkHasContent(chunk: any): boolean {
  for (const choice of chunk?.choices ?? []) {
    const delta = choice?.delta
    if (typeof delta?.content === "string" && delta.content.length > 0) return true
    if (reasoningOf(delta) !== undefined) return true
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true
  }
  return false
}

/** Whether one decoded chunk is an error payload rather than a completion. */
export function chunkError(chunk: any): string | null {
  if (chunk?.error !== undefined && chunk?.choices === undefined) {
    return errorText(chunk.error) || "the gateway returned an error frame"
  }
  return null
}

/** Unwrap a gateway envelope and return the OpenAI-shaped chunk. */
export function openAIChunk(payload: unknown): any {
  return unwrapEnvelope<any>(payload)
}

/** A watchdog that aborts after a period with no activity. */
export class IdleWatchdog {
  readonly controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private readonly ms: number
  private readonly label: string
  timedOut = false
  private disposed = false

  constructor(ms: number, label = "stream idle timeout") {
    this.ms = ms
    this.label = label
    if (Number.isFinite(ms) && ms > 0) this.touch()
  }

  /** Reset the idle clock. */
  touch(): void {
    if (this.disposed || this.timedOut) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error(`${this.label} after ${this.ms}ms`))
    }, this.ms)
    // Never keep the host process alive just for a watchdog.
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
