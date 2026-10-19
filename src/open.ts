/**
 * Open a local URL in the user's default browser.
 *
 * The dashboard listens on an ephemeral loopback port, so the URL is resolved
 * from the running gateway rather than hard-coded. `spawn` is detached and
 * silent: a failed browser launch must not take the opencode server down.
 */
import { spawn } from "node:child_process"
import { errorChain } from "./errors.js"
import type { Logger } from "./log.js"

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform
  logger?: Logger
  spawnImpl?: typeof spawn
}

/** Open one http(s) URL in the platform browser. */
export function openInBrowser(url: string, options: OpenBrowserOptions = {}): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new Error(`not a valid URL: ${url}`, { cause: error })
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`refusing to open a non-http URL: ${url}`)
  }
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]] as const
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]] as const
        : ["xdg-open", [url]] as const
  const child = spawnImpl(command, [...args], { detached: true, stdio: "ignore", windowsHide: true })
  child.on("error", (error) => {
    options.logger?.warn("[cline-pass] could not open the dashboard in a browser: %s", errorChain(error))
  })
  child.unref()
}
