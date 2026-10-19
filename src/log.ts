/** A tiny leveled logger. opencode captures plugin stderr in its own logs. */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

function format(message: string, args: unknown[]): string {
  if (args.length === 0) return message
  let index = 0
  return message.replace(/%[sdifoOj]/g, (token) => {
    if (index >= args.length) return token
    const value = args[index++]
    try {
      return typeof value === "string" ? value : token === "%j" ? JSON.stringify(value) : String(value)
    } catch {
      return String(value)
    }
  })
}

/** Create a logger writing to stderr with a stable prefix. */
export function createLogger(prefix = "[cline-pass]", sink: Pick<Console, "debug" | "info" | "warn" | "error"> = console): Logger {
  const label = prefix.length > 0 ? `${prefix} ` : ""
  const emit = (method: "debug" | "info" | "warn" | "error", message: string, args: unknown[]) => {
    sink[method](`${label}${format(message, args)}`)
  }
  return {
    debug(message, ...args) {
      emit("debug", message, args)
    },
    info(message, ...args) {
      emit("info", message, args)
    },
    warn(message, ...args) {
      emit("warn", message, args)
    },
    error(message, ...args) {
      emit("error", message, args)
    },
  }
}

/** A logger that discards everything, for tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
