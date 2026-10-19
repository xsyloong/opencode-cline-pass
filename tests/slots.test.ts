import { describe, expect, it } from "vitest"
import { createUpstreamSlots } from "../src/slots.js"

describe("per-account stream slots", () => {
  it("serializes beyond the limit and admits in FIFO order", async () => {
    const slots = createUpstreamSlots()
    const order: string[] = []
    const first = await slots.acquire("a", 1)
    const secondPromise = slots.acquire("a", 1).then((release) => {
      order.push("second")
      return release
    })
    const thirdPromise = slots.acquire("a", 1).then((release) => {
      order.push("third")
      return release
    })
    expect(order).toEqual([])
    first()
    const second = await secondPromise
    expect(order).toEqual(["second"])
    second()
    const third = await thirdPromise
    expect(order).toEqual(["second", "third"])
    third()
  })

  it("counts accounts apart", async () => {
    const slots = createUpstreamSlots()
    const a = await slots.acquire("a", 1)
    const b = await slots.acquire("b", 1)
    expect(typeof a).toBe("function")
    expect(typeof b).toBe("function")
    a()
    b()
  })

  it("lifts the cap at zero", async () => {
    const slots = createUpstreamSlots()
    const holds = await Promise.all([slots.acquire("a", 0), slots.acquire("a", 0), slots.acquire("a", 0)])
    expect(holds).toHaveLength(3)
    holds.forEach((release) => release())
  })

  it("removes an aborted waiter from the queue", async () => {
    const slots = createUpstreamSlots()
    const first = await slots.acquire("a", 1)
    const controller = new AbortController()
    const waiting = slots.acquire("a", 1, controller.signal)
    controller.abort(new Error("stop"))
    await expect(waiting).rejects.toThrow("stop")
    first()
    // The queue is empty, so the next caller gets the slot immediately.
    const next = await slots.acquire("a", 1)
    next()
  })

  it("releases idempotently", async () => {
    const slots = createUpstreamSlots()
    const release = await slots.acquire("a", 2)
    release()
    release()
    const first = await slots.acquire("a", 2)
    const second = await slots.acquire("a", 2)
    first()
    second()
  })

  it("frees a held slot when its signal aborts", async () => {
    const slots = createUpstreamSlots()
    const controller = new AbortController()
    const release = await slots.acquire("a", 1, controller.signal)
    controller.abort()
    const next = await slots.acquire("a", 1)
    expect(typeof next).toBe("function")
    next()
    release()
  })
})
