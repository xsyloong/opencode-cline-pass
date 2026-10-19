/** Stable error codes and the error type every module routes on. */
import type { Usage } from "./types.js"

export const QUOTA_EXCEEDED_CODE = "QUOTA"
export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED"
export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"
export const STREAM_CLOSED_CODE = "STREAM_CLOSED"
export const AUTH_CODE = "AUTH"
export const RATE_LIMIT_CODE = "RATE_LIMIT"
export const INVALID_REQUEST_CODE = "INVALID_REQUEST"
export const SERVER_CODE = "SERVER"
export const UPSTREAM_CODE = "UPSTREAM"
export const TIMEOUT_CODE = "TIMEOUT"
export const ABORTED_CODE = "ABORTED"
export const TRANSPORT_CODE = "TRANSPORT"
export const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL"
export const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL"
export const UNSUPPORTED_CONTENT_CODE = "UNSUPPORTED_CONTENT"
export const INVALID_ADAPTER_CODE = "INVALID_ADAPTER"

export interface ErrorOptions {
  status?: number
  cause?: unknown
}

/** One failure with a stable, routeable code. */
export class ClinePassError extends Error {
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ClinePassError"
    this.code = code
    this.status = options.status
  }
}

/** Render any thrown value as display text. */
export function errorText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Render a thrown value with its cause chain, for transport diagnostics. */
export function errorChain(value: unknown): string {
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (current === null || current === undefined) return String(current)
    if (path.has(current)) return "<circular cause>"
    path.add(current)
    if (current instanceof AggregateError && current.errors.length > 0) {
      return `${current.message} [${current.errors.map(render).join("; ")}]`
    }
    const message = errorText(current)
    const cause = (current as { cause?: unknown }).cause
    if (cause === undefined || cause === null) return message
    const rendered = render(cause)
    if (rendered === message || rendered === "") return message
    return message === "" ? rendered : `${message}: ${rendered}`
  }
  return render(value)
}

/** Map one HTTP status plus detail text to a stable code. */
export function codeForStatus(status: number | undefined, message: string): string {
  const detail = String(message ?? "")
  if (status === 402 || isQuotaExceededError(detail) || isSpentWindow(detail)) return QUOTA_EXCEEDED_CODE
  if (isAuthenticationError(detail, status)) return AUTH_CODE
  if (status === 429 || /\b429\b|rate[\s_-]?limit/i.test(detail)) return RATE_LIMIT_CODE
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 400) return INVALID_REQUEST_CODE
  if (status !== undefined && status >= 500) return SERVER_CODE
  if (status !== undefined && status >= 400) return `HTTP_${status}`
  return UPSTREAM_CODE
}

/**
 * Recognize provider wording that identifies an exhausted account quota
 * rather than a transient request-rate limit.
 */
export function isQuotaExceededError(detail: string): boolean {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail) ||
    /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
  )
}

/**
 * Cline also refuses spent subscription windows. Require exhaustion, not just
 * a window name, so a temporary error fetching weekly usage does not stand an
 * account down.
 */
export function isSpentWindow(detail: string): boolean {
  const text = String(detail ?? "").replace(/[_-]/g, " ")
  return /\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,80}?\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*|spent)\b|\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*)\b[\s\S]{0,80}?\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,40}?\b(?:limit|cap|quota|credits|budget|allowance)\b/i.test(
    text,
  )
}

/** Context-window refusals, in the vocabulary providers actually use. */
export function isContextWindowExceededError(detail: string): boolean {
  const text = String(detail ?? "")
  return (
    /context[_-]?length[_-]?exceeded/i.test(text) ||
    /maximum\s+context\s+length/i.test(text) ||
    /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(text) ||
    /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(text) ||
    /exceeds?\s+(?:the\s+)?(?:model'?s?\s+)?(?:maximum\s+)?context/i.test(text)
  )
}

/** Account authentication refusals, including responses with no useful body. */
export function isAuthenticationError(message: string, status?: number): boolean {
  const detail = String(message ?? "").replace(/[_-]/g, " ")
  return (
    status === 401 ||
    status === 403 ||
    /unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)|\b401\b|\b403\b/i.test(detail)
  )
}

/** Whether a value is an abort error. */
export function isAbortError(value: unknown): boolean {
  return (
    (value instanceof Error && value.name === "AbortError") ||
    (typeof value === "object" && value !== null && (value as { name?: string }).name === "AbortError")
  )
}

/** Map a usage frame to the host's disjoint counts. */
export function mapUsage(usage: unknown): Usage | null {
  if (usage === null || usage === undefined || typeof usage !== "object") return null
  const raw = usage as Record<string, any>
  const promptDetails = raw.prompt_tokens_details ?? {}
  const completionDetails = raw.completion_tokens_details ?? {}
  const cacheRead = promptDetails.cached_tokens ?? raw.prompt_cache_hit_tokens
  const reasoning = completionDetails.reasoning_tokens
  const input = Number.isSafeInteger(raw.prompt_tokens) ? raw.prompt_tokens : 0
  const output = Number.isSafeInteger(raw.completion_tokens) ? raw.completion_tokens : 0
  const combined = input + output
  const hasExactTotal = Number.isSafeInteger(raw.total_tokens) ? raw.total_tokens === combined : true
  return {
    inputTokens: input - (typeof cacheRead === "number" ? cacheRead : 0),
    outputTokens: output,
    ...(hasExactTotal ? { totalTokens: combined } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: Number(cacheRead) }),
    ...(reasoning === undefined ? {} : { reasoningTokens: Number(reasoning) }),
  }
}
