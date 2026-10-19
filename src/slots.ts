/**
 * Per-account slots for streams open to the gateway.
 *
 * A slot is held for a whole attempt — from before `fetch` until the response
 * body is closed — because the stream, not the wait for headers, is what keeps
 * a socket and the account's concurrency busy. Accounts are counted apart, so a
 * stalled account cannot hold up requests routed to a healthy one.
 *
 * Waiters are served first in, first out, and a freed slot is handed to the
 * next waiter and counted in the same step, so a request arriving in between
 * cannot take it as well. A waiter whose signal aborts leaves the queue at
 * once; a held slot is also freed when its signal aborts.
 */

interface Pool {
  active: number
  limit: number
  waiting: Array<() => void>
}

export interface UpstreamSlots {
  acquire(key: string, limit: number, signal?: AbortSignal): Promise<() => void>
}

/** Create one slot table shared by every request to the same account. */
export function createUpstreamSlots(): UpstreamSlots {
  const pools = new Map<string, Pool>()

  const admit = (pool: Pool): void => {
    while (pool.waiting.length > 0 && pool.active < pool.limit) {
      pool.active += 1
      pool.waiting.shift()!()
    }
  }

  const hold = (pool: Pool, signal?: AbortSignal): (() => void) => {
    let held = true
    const release = (): void => {
      if (!held) return
      held = false
      signal?.removeEventListener("abort", release)
      pool.active -= 1
      admit(pool)
    }
    signal?.addEventListener("abort", release, { once: true })
    // A signal that aborted between the grant and this call must not keep a
    // slot; the caller's request is already doomed.
    if (signal?.aborted === true) release()
    return release
  }

  return {
    async acquire(key, limit, signal) {
      signal?.throwIfAborted()
      let pool = pools.get(key)
      if (pool === undefined) {
        pool = { active: 0, limit: Number.POSITIVE_INFINITY, waiting: [] }
        pools.set(key, pool)
      }
      // Read on every call, so a changed setting reaches the next request; a
      // raised limit admits the queue before this caller joins it.
      pool.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : Number.POSITIVE_INFINITY
      admit(pool)
      if (pool.waiting.length === 0 && pool.active < pool.limit) {
        pool.active += 1
        return hold(pool, signal)
      }
      return await new Promise<() => void>((resolve, reject) => {
        const grant = (): void => {
          signal?.removeEventListener("abort", abandon)
          resolve(hold(pool!, signal))
        }
        const abandon = (): void => {
          const at = pool!.waiting.indexOf(grant)
          if (at !== -1) pool!.waiting.splice(at, 1)
          reject(signal?.reason ?? new Error("the request was aborted while waiting for a stream slot"))
        }
        pool!.waiting.push(grant)
        signal?.addEventListener("abort", abandon, { once: true })
      })
    },
  }
}

/** How many slots are currently active for one account, for diagnostics. */
export function createCountingSlots(): UpstreamSlots & { counts(): Record<string, number> } {
  const slots = createUpstreamSlots()
  const counts = new Map<string, number>()
  return {
    async acquire(key, limit, signal) {
      const release = await slots.acquire(key, limit, signal)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        counts.set(key, Math.max(0, (counts.get(key) ?? 1) - 1))
        release()
      }
    },
    counts: () => Object.fromEntries(counts),
  }
}
