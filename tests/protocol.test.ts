import { describe, expect, it } from "vitest"
import {
  MAX_UPSTREAMS,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  isAdherenceOk,
  mergeUpstreams,
  normalizePinMode,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  reasoningOf,
} from "../src/protocol.js"
import { streamErrorCode } from "../src/stream.js"
import { mapUsage } from "../src/errors.js"
import { providerModelKey, wireModelId } from "../src/catalog.js"

describe("pin injection", () => {
  it("writes both spellings by default", () => {
    const planner = injectPrefs({ model: "m" }, { pipeline: "planner" }, { upstream: "baseten", strict: true, sort: null })
    expect(planner.providerOptions.gateway.only).toEqual(["baseten"])
    expect(planner.provider.only).toEqual(["baseten"])

    const direct = injectPrefs({ model: "m" }, { pipeline: "direct" }, { upstream: "gmicloud", strict: true, sort: null })
    expect(direct.provider.only).toEqual(["gmicloud"])
    expect(direct.providerOptions.gateway.only).toEqual(["gmicloud"])
  })

  it("honors the detected spelling policy", () => {
    const planner = injectPrefs(
      { model: "m" },
      { pipeline: "planner" },
      { upstream: "a", strict: true, spelling: "detected" },
    )
    expect(planner.provider).toBeUndefined()
    expect(planner.providerOptions.gateway.only).toEqual(["a"])

    const direct = injectPrefs(
      { model: "m" },
      { pipeline: "direct" },
      { upstream: "a", strict: true, spelling: "detected" },
    )
    expect(direct.providerOptions).toBeUndefined()
    expect(direct.provider.only).toEqual(["a"])
  })

  it("leaves a body with no pin and no exclusion untouched", () => {
    expect(injectPrefs({ model: "m" }, {}, {})).toEqual({ model: "m" })
  })

  it("translates channel aliases per pipeline", () => {
    expect(channelNameFor("z-ai", "planner")).toBe("zai")
    expect(channelNameFor("zai", "direct")).toBe("z-ai")
    expect(channelNameFor("baseten", "direct")).toBe("baseten")

    const body = injectPrefs({ model: "m" }, { pipeline: "planner" }, { upstream: "zai", strict: true })
    expect(body.providerOptions.gateway.only).toEqual(["zai"])
    expect(body.provider.only).toEqual(["z-ai"])
  })

  it("compiles exclusions into a per-pipeline allow-list plus OpenRouter ignore", () => {
    const meta = {
      pipeline: "planner" as const,
      upstreams: ["a", "b", "z"],
      channels: { planner: ["a", "b"], direct: ["a", "z"] },
    }
    const body = injectPrefs({ model: "m" }, meta, { upstream: null, excludeList: ["b"], strict: true })
    expect(body.providerOptions.gateway.only).toEqual(["a"])
    expect(body.provider.only).toEqual(["a", "z"])
    expect(body.provider.ignore).toEqual(["b"])
  })

  it("excludes the same channel under every alias", () => {
    const meta = {
      pipeline: "planner" as const,
      upstreams: ["zai", "alibaba"],
      channels: { planner: ["zai", "alibaba"], direct: ["z-ai", "alibaba"] },
    }
    for (const exclude of ["zai", "z-ai", "Z.AI"]) {
      const attempt = buildAttempts({ upstreams: [], exclude: [exclude] })[0]!
      const wire = injectPrefs({ model: "m" }, meta, attempt)
      expect(wire.providerOptions.gateway.only).toEqual(["alibaba"])
      expect(wire.provider.only).toEqual(["alibaba"])
      expect(buildAttempts({ upstreams: ["zai", "alibaba"], exclude: [exclude] }).map((a) => a.upstream)).toEqual([
        "alibaba",
      ])
    }
  })

  it("maps sort names for OpenRouter and drops none", () => {
    const body = injectPrefs({ model: "m" }, {}, { upstream: null, sort: "cost", excludeList: [] })
    expect(body.provider.sort).toBe("price")
    expect(body.providerOptions.gateway.sort).toBe("cost")

    const none = injectPrefs({ model: "m" }, {}, { upstream: null, sort: "none", excludeList: [] })
    expect(none.provider).toBeUndefined()
    expect(injectPrefs({ model: "m" }, {}, { upstream: null, sort: "", excludeList: [] })).toEqual({ model: "m" })
  })
})

describe("candidate expansion", () => {
  it("keeps the historical shape for a bare profile", () => {
    expect(buildAttempts({ upstreams: [], exclude: ["a"] })).toEqual([
      { strict: true, sort: null, excludeList: ["a"], upstream: null, orderRest: [] },
    ])
  })

  it("expands strict and preferred pins", () => {
    expect(buildAttempts({ upstreams: ["a", "b"], pinMode: "strict" })).toEqual([
      { strict: true, sort: null, excludeList: [], upstream: "a", orderRest: [] },
      { strict: true, sort: null, excludeList: [], upstream: "b", orderRest: [] },
    ])
    expect(buildAttempts({ upstreams: ["a", "b"], pinMode: "preferred" })).toEqual([
      { strict: false, sort: null, excludeList: [], upstream: "a", orderRest: ["b"] },
      { strict: false, sort: null, excludeList: [], upstream: "b", orderRest: ["a"] },
    ])
  })

  it("normalizes pin modes", () => {
    expect(normalizePinMode(" Preferred ")).toBe("preferred")
    expect(normalizePinMode("STRICT")).toBe("strict")
    expect(normalizePinMode(undefined)).toBe("strict")
    expect(normalizePinMode("nonsense")).toBe("strict")
    expect(buildAttempts({ upstreams: ["a", "b"], pinMode: "strict " })[0]!.strict).toBe(true)
    expect(buildAttempts({ upstreams: ["a", "b"], pinMode: " preferred " })[0]!.strict).toBe(false)
  })

  it("drops excluded channels from the chain", () => {
    expect(buildAttempts({ upstreams: ["a", "b"], exclude: ["b"] }).map((a) => a.upstream)).toEqual(["a"])
  })
})

describe("adherence", () => {
  it("recognizes adoption, fallback, mismatch and violations", () => {
    const routing = (finalProvider: string | null) => ({ finalProvider })
    expect(pinAdherence({ upstream: "baseten" }, routing("baseten"))).toBe("adopted")
    expect(pinAdherence({ upstream: "baseten" }, routing("deepseek"))).toBe("not-adopted")
    expect(pinAdherence({ upstream: "together-ai" }, routing("Together AI"))).toBe("adopted")
    expect(pinAdherence({ upstream: "a", orderRest: ["b"] }, routing("b"))).toBe("fallback")
    expect(pinAdherence({ upstream: "a", excludeList: ["deepseek"] }, routing("deepseek"))).toBe("violated")
    expect(pinAdherence({ upstream: null, excludeList: ["deepseek"] }, routing("deepseek"))).toBe("violated")
    expect(pinAdherence({ upstream: "a", excludeList: ["a"] }, routing("a"))).toBe("adopted")
    expect(pinAdherence({ upstream: "baseten" }, routing(null))).toBe("unresolved")
    expect(pinAdherence({ upstream: null }, routing("anything"))).toBe("unresolved")
  })

  it("accepts adopted, fallback and unresolved only", () => {
    expect(isAdherenceOk("adopted")).toBe(true)
    expect(isAdherenceOk("fallback")).toBe(true)
    expect(isAdherenceOk("unresolved")).toBe(true)
    expect(isAdherenceOk("violated")).toBe(false)
    expect(isAdherenceOk("not-adopted")).toBe(false)
  })
})

describe("warnings and discovery", () => {
  it("warns when an exclusion cannot be expressed", () => {
    expect(pinWarnings({ upstream: "a" }, { upstreams: ["a", "b"] })).toEqual([])
    expect(pinWarnings({ upstream: null, excludeList: ["b"] }, { upstreams: [] })[0]).toMatch(/excludeUnresolved/)
    expect(pinWarnings({ upstream: null, excludeList: ["a", "b"] }, { upstreams: ["a", "b"] })[0]).toMatch(
      /PIN_UNRESOLVED/,
    )
    expect(pinWarnings({ upstream: null, excludeList: ["b"] }, { upstreams: ["a", "b"] })).toEqual([])
    expect(pinWarnings({ upstream: "a", excludeList: ["a"] }, { upstreams: ["a"] })).toEqual([])
  })

  it("merges, de-duplicates and keeps wide pools", () => {
    expect(mergeUpstreams(["b", "a"], ["a", "c"])).toEqual(["b", "a", "c"])
    expect(mergeUpstreams(Array.from({ length: 80 }, (_, i) => `ch-${i}`))).toHaveLength(MAX_UPSTREAMS)
    expect(MAX_UPSTREAMS).toBeGreaterThan(25)
  })

  it("parses routing facts and tier hints", () => {
    const direct = parseRouting({
      model: "z-ai/glm-5.2",
      provider: "Z.AI",
      choices: [{ message: { content: "ok" } }],
    })
    expect(direct.pipeline).toBe("direct")
    expect(direct.finalProvider).toBe("z.ai")
    expect(direct.canonicalSlug).toBe("z-ai/glm-5.2")

    const fromDelta = parseRouting({
      choices: [
        {
          delta: {
            provider_metadata: {
              gateway: { routing: { finalProvider: "deepseek", canonicalSlug: "deepseek/deepseek-v4.1-flash" } },
            },
          },
        },
      ],
    })
    expect(fromDelta.pipeline).toBe("planner")
    expect(fromDelta.finalProvider).toBe("deepseek")
    expect(fromDelta.canonicalSlug).toBe("deepseek/deepseek-v4.1-flash")

    const planner = parseRouting({
      choices: [{ message: { content: "ok", provider_metadata: { gateway: { routing: { finalProvider: "baseten", fallbacksAvailable: ["a"] } } } } }],
    })
    expect(planner.pipeline).toBe("planner")
    expect(planner.fallbacks).toEqual(["a"])
    expect(parseTier0("alibaba won tier 0 over baseten, deepseek")).toEqual(["alibaba", "baseten", "deepseek"])
  })

  it("extracts provider lists from both router diagnostics", () => {
    expect(
      extractAvailableProviders("No providers. Available providers are: alibaba, baseten.", "planner"),
    ).toEqual(["alibaba", "baseten"])
    expect(
      extractAvailableProviders('error: {"error":{"metadata":{"available_providers":["a","b"]}}}', "direct"),
    ).toEqual(["a", "b"])
    expect(extractAvailableProviders("nothing", "planner")).toBeNull()
  })

  it("classifies upstream failures", () => {
    expect(classifyUpstreamError("empty response content")).toBe("ok")
    expect(classifyUpstreamError("429 Too Many Requests")).toBe("limited")
    expect(classifyUpstreamError("no available providers")).toBe("bad")
    expect(classifyUpstreamError("invalid api key")).toBe("auth")
    expect(classifyUpstreamError("mystery")).toBe("unknown")
  })
})

describe("stream helpers", () => {
  it("classifies quota, auth, rate and context failures", () => {
    for (const message of [
      "Weekly limit reached",
      "Your weekly usage limit has been exceeded",
      "five_hour usage limit exceeded",
      "monthly allowance used up",
      "Plan limit reached",
    ]) {
      expect(streamErrorCode(message, 429)).toBe("QUOTA")
    }
    expect(streamErrorCode("Payment required", 402)).toBe("QUOTA")
    expect(streamErrorCode("429 Too Many Requests", 429)).toBe("RATE_LIMIT")
    expect(streamErrorCode("invalid api key", 401)).toBe("AUTH")
    expect(streamErrorCode("maximum context length exceeded", 400)).toBe("CONTEXT_WINDOW_EXCEEDED")
    expect(streamErrorCode("weekly usage endpoint temporarily unavailable", 503)).toBe("SERVER")
  })

  it("maps usage to disjoint counts", () => {
    expect(
      mapUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 40,
      reasoningTokens: 7,
    })
    expect(mapUsage(null)).toBeNull()
  })

  it("reads every reasoning spelling", () => {
    expect(reasoningOf({ reasoning: "a" })).toBe("a")
    expect(reasoningOf({ reasoning_content: "b" })).toBe("b")
    expect(reasoningOf({ reasoning_details: [{ text: "c" }, { text: "d" }] })).toBe("cd")
    expect(reasoningOf({})).toBeUndefined()
  })
})

describe("model ids", () => {
  it("round-trips bare opencode keys and wire ids", () => {
    expect(providerModelKey("cline-pass/glm-5.2")).toBe("glm-5.2")
    expect(providerModelKey("glm-5.2")).toBe("glm-5.2")
    expect(wireModelId("glm-5.2")).toBe("cline-pass/glm-5.2")
    expect(wireModelId("cline-pass/glm-5.2")).toBe("cline-pass/glm-5.2")
    expect(wireModelId("")).toBe("")
  })
})
