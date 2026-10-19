import { describe, expect, it } from "vitest"
import { createStore } from "../src/store.js"

describe("observation store", () => {
  it("merges learned metadata and verdicts", () => {
    const store = createStore()
    store.learn("m", { pipeline: "planner", upstreams: ["a"] })
    store.learnUpstream("m", "a", "ok", "fine", 12)
    expect(store.metaOf("m").pipeline).toBe("planner")
    expect(store.metaOf("m").upstreamStatus?.a).toMatchObject({ status: "ok", note: "fine", ms: 12 })
    store.learn("m", { upstreamStatus: { a: { status: "bad", note: "", ms: 1, checkedAt: 1 } } })
    expect(store.metaOf("m").upstreamStatus?.a?.status).toBe("bad")
  })

  it("ignores unknown verdicts unless a validation asks for them", () => {
    const store = createStore()
    store.learnUpstream("m", "a", "unknown", "", 1)
    expect(store.metaOf("m").upstreamStatus).toBeUndefined()
    store.learnUpstream("m", "a", "unknown", "inconclusive", 1, { includeUnknown: true })
    expect(store.metaOf("m").upstreamStatus?.a?.status).toBe("unknown")
  })

  it("caps history and always advances the revision", () => {
    const store = createStore({ historyLimit: 2 })
    store.record({ model: "m", stream: true } as any)
    store.record({ model: "m", stream: true } as any)
    store.record({ model: "m", stream: true } as any)
    expect(store.historySize()).toBe(2)
    expect(store.historyRevision()).toBe(3)
    expect(store.readHistory(10)).toHaveLength(2)
    expect(store.readHistory(1)[0]).toMatchObject({ model: "m" })
  })

  it("filters history by model substring, case-insensitively", () => {
    const store = createStore()
    store.record({ model: "cline-pass/glm-5.2", stream: true } as any)
    store.record({ model: "cline-pass/kimi-k3", stream: true } as any)
    expect(store.readHistory(10, "GLM")).toHaveLength(1)
    expect(store.readHistory(10, "")).toHaveLength(2)
  })

  it("trims when the retention cap shrinks", () => {
    const store = createStore({ historyLimit: 5 })
    for (let index = 0; index < 5; index += 1) store.record({ model: "m", stream: true } as any)
    store.setHistoryLimit(2)
    expect(store.historySize()).toBe(2)
    expect(store.historyRevision()).toBe(5)
  })

  it("deduplicates and bounds the channel list", () => {
    const store = createStore()
    store.learn("m", { upstreams: Array.from({ length: 100 }, (_, index) => `ch-${index}`) })
    expect(store.metaOf("m").upstreams).toHaveLength(64)
    store.learn("m", { upstreams: ["a", "a", "", "b"] })
    expect(store.metaOf("m").upstreams).toEqual(["a", "b"])
  })

  it("caches the catalog and quota readings", () => {
    const store = createStore()
    store.setCatalog({ ids: ["cline-pass/a"], models: {}, sources: ["models.dev"] })
    expect(store.catalog().fetchedAt).toBeGreaterThan(0)
    store.setUsage({ ok: true, accounts: [] })
    expect(store.usage()).toMatchObject({ ok: true, accounts: [] })
  })
})
