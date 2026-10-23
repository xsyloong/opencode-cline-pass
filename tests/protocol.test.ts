import { describe, expect, it } from "vitest"
import {
  MAX_UPSTREAMS,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  isAdherenceOk,
  isKnownCapability,
  mergeUpstreams,
  normalizeCapabilities,
  normalizePinMode,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  routeLocked,
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

  it("writes the capability gate beside every planner allow-list", () => {
    // The gate is what makes `only` reach the router on a VMC-fixed id: without
    // it the planner routes to the private channel and drops the pin silently.
    const strict = injectPrefs(
      { model: "m" },
      { pipeline: "planner" },
      { upstream: "deepseek", strict: true, capabilities: ["vision", "implicit-caching"] },
    )
    expect(strict.providerOptions.gateway.only).toEqual(["deepseek"])
    expect(strict.providerOptions.gateway.has).toEqual(["vision", "implicit-caching"])

    const preferred = injectPrefs(
      { model: "m" },
      { pipeline: "planner" },
      { upstream: "a", orderRest: ["b"], strict: false, capabilities: ["Tool-Use", "vision", "vision"] },
    )
    expect(preferred.providerOptions.gateway.only).toEqual(["a", "b"])
    expect(preferred.providerOptions.gateway.has).toEqual(["tool-use", "vision"])

    const excluded = injectPrefs(
      { model: "m" },
      { pipeline: "planner", upstreams: ["a", "b"] },
      { upstream: null, excludeList: ["b"], strict: true, capabilities: ["vision"] },
    )
    expect(excluded.providerOptions.gateway.only).toEqual(["a"])
    expect(excluded.providerOptions.gateway.has).toEqual(["vision"])
  })

  it("omits the gate when it is empty and never writes it alone", () => {
    const off = injectPrefs(
      { model: "m" },
      { pipeline: "planner" },
      { upstream: "deepseek", strict: true, capabilities: [] },
    )
    expect(off.providerOptions.gateway.has).toBeUndefined()

    // Sort alone is not a pin, so no gate: `has` on its own changes the route.
    const sortOnly = injectPrefs({ model: "m" }, {}, { upstream: null, sort: "cost", capabilities: ["vision"] })
    expect(sortOnly.providerOptions.gateway.has).toBeUndefined()

    // A detected direct route carries no planner spelling at all.
    const direct = injectPrefs(
      { model: "m" },
      { pipeline: "direct" },
      { upstream: "a", strict: true, spelling: "detected", capabilities: ["vision"] },
    )
    expect(direct.providerOptions).toBeUndefined()
  })

  it("keeps an unpinnable private channel out of a derived allow-list", () => {
    // The VMC's private channel serves the probe, so it heads the discovered
    // list, but the gate cannot select it. An exclusion-derived allow-list must
    // not inherit it, or an exclusion turns into a 400 for a channel nobody named.
    const meta = {
      pipeline: "planner" as const,
      capabilityGated: true,
      upstreams: ["openai-compatible-private", "alibaba", "baseten"],
      channels: { planner: ["openai-compatible-private", "alibaba", "baseten"] },
      availableProviders: ["alibaba", "baseten"],
    }
    const derived = injectPrefs(
      { model: "m" },
      meta,
      { upstream: null, excludeList: ["deepseek"], strict: true, capabilities: ["vision"] },
    )
    expect(derived.providerOptions.gateway.only).toEqual(["alibaba", "baseten"])

    // An explicit pin is left untouched: the gateway's 400 is the honest answer.
    const explicit = injectPrefs(
      { model: "m" },
      meta,
      { upstream: "openai-compatible-private", strict: true, capabilities: ["vision"] },
    )
    expect(explicit.providerOptions.gateway.only).toEqual(["openai-compatible-private"])

    // Without the gate nothing is filtered: the old list is still the old list.
    const ungated = injectPrefs(
      { model: "m" },
      { ...meta, capabilityGated: false },
      { upstream: null, excludeList: ["deepseek"], strict: true, capabilities: [] },
    )
    expect(ungated.providerOptions.gateway.only).toEqual(["openai-compatible-private", "alibaba", "baseten"])
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
    // `preferred` cannot be expressed as an order on the planner pipeline, so it
    // becomes one attempt over the whole candidate set plus one unpinned
    // fallback: the set is what the router honors, and the last attempt keeps
    // "preferred" permissive when the whole set refuses.
    expect(buildAttempts({ upstreams: ["a", "b"], pinMode: "preferred" })).toEqual([
      { strict: false, sort: null, excludeList: [], upstream: "a", orderRest: ["b"] },
      { strict: false, sort: null, excludeList: [], upstream: null, orderRest: [] },
    ])
  })

  it("compiles a preferred pin into an allow-list, not just a wish", () => {
    const meta = { upstreams: ["a", "b", "c"], pipeline: "planner" as const }
    const pinned = injectPrefs(
      { model: "m" },
      meta,
      { upstream: "a", orderRest: ["b"], strict: false, excludeList: [] },
    )
    // `order` alone was silently equivalent to no pin at all.
    expect(pinned.providerOptions.gateway.order).toEqual(["a", "b"])
    expect(pinned.providerOptions.gateway.only).toEqual(["a", "b"])
    expect(pinned.provider.only).toEqual(["a", "b"])

    // A single candidate is still a hard set: "prefer" with nothing to fall
    // back to means exactly that one channel.
    const single = injectPrefs({ model: "m" }, meta, { upstream: "c", orderRest: [], strict: false, excludeList: [] })
    expect(single.providerOptions.gateway.only).toEqual(["c"])

    // The trailing unpinned attempt writes no channel preference at all.
    const auto = injectPrefs({ model: "m" }, meta, { upstream: null, orderRest: [], strict: false, excludeList: [] })
    expect(auto.providerOptions?.gateway?.only).toBeUndefined()
    expect(auto.providerOptions?.gateway?.order).toBeUndefined()
    expect(auto.provider?.only).toBeUndefined()
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

  it("carries the capability gate on every attempt", () => {
    const attempts = buildAttempts({ upstreams: ["a", "b"], capabilities: ["vision", "vision", " Tool-Use "] })
    expect(attempts[0]!.capabilities).toEqual(["vision", "tool-use"])
    expect(attempts[1]!.capabilities).toEqual(["vision", "tool-use"])
    // An empty gate is omitted rather than written as `has: []`, which the
    // planner ignores anyway and which would hide that pinning is off.
    expect(buildAttempts({ upstreams: ["a"], capabilities: [] })[0]!.capabilities).toBeUndefined()
    expect(buildAttempts({ upstreams: ["a"] })[0]!.capabilities).toBeUndefined()
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

  it("warns when a planner pin has no capability gate", () => {
    // Without the gate a VMC id silently drops `only`, so this is the one
    // misconfiguration that produces a clean 200 with the wrong channel.
    const planner = { upstreams: ["a"], pipeline: "planner" as const }
    expect(pinWarnings({ upstream: "a" }, planner)[0]).toMatch(/PIN_GATE_MISSING/)
    expect(pinWarnings({ upstream: "a", capabilities: ["vision"] }, planner)).toEqual([])
    // A direct route never reads providerOptions, so the gate is not demanded.
    expect(pinWarnings({ upstream: "a" }, { upstreams: ["a"], pipeline: "direct" as const })).toEqual([])
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
    // A capability refusal is the channel's own verdict, not a transient fault.
    expect(
      classifyUpstreamError(
        '{"error":{"message":"None of the providers considered for deepseek/deepseek-v4.1-flash-1017 satisfy the required has conditions: quantization:fp8.","type":"no_capable_providers_available"}}',
      ),
    ).toBe("bad")
    expect(
      classifyUpstreamError("has entries must be one of free, implicit-caching, reasoning"),
    ).toBe("bad")
  })

  it("normalizes the capability gate without silently weakening it", () => {
    expect(normalizeCapabilities([" Vision ", "vision", "tool-use"])).toEqual(["vision", "tool-use"])
    expect(normalizeCapabilities(undefined)).toEqual([])
    expect(normalizeCapabilities([], ["vision"])).toEqual([])
    expect(normalizeCapabilities(undefined, ["vision"])).toEqual(["vision"])
    // Unknown values are kept: the planner's 400 names the whole vocabulary.
    expect(normalizeCapabilities(["visoin"])).toEqual(["visoin"])
    expect(isKnownCapability("vision")).toBe(true)
    expect(isKnownCapability("quantization")).toBe(false)
    expect(isKnownCapability("quantization:fp8")).toBe(true)
    expect(isKnownCapability("!quantization:bf16")).toBe(true)
    expect(isKnownCapability("vision ")).toBe(true)
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

  it("lets an alias override both the bare key and the prefixed id", () => {
    const aliases = { "cline-pass/deepseek-v4.1-flash-1017-open": "deepseek/deepseek-v4.1-flash-1017" }
    expect(wireModelId("deepseek-v4.1-flash-1017-open", aliases)).toBe("deepseek/deepseek-v4.1-flash-1017")
    expect(wireModelId("cline-pass/deepseek-v4.1-flash-1017-open", aliases)).toBe(
      "deepseek/deepseek-v4.1-flash-1017",
    )
    // An unaliased id keeps the prefix rule.
    expect(wireModelId("glm-5.2", aliases)).toBe("cline-pass/glm-5.2")
  })

  it("reads the VMC off a routed answer and treats it as a locked route", () => {
    const locked = parseRouting({
      model: "vmc/deepseek-v4p1-flash-1017-contributor-fallbacks",
      choices: [
        {
          message: {
            provider_metadata: {
              gateway: {
                virtualModelConfig: { modelId: "deepseek-v4p1-flash-1017-contributor-fallbacks" },
                routing: { finalProvider: "openai-compatible-private", fallbacksAvailable: [] },
              },
            },
          },
        },
      ],
    })
    expect(locked.virtualModel).toBe("deepseek-v4p1-flash-1017-contributor-fallbacks")
    expect(routeLocked(locked)).toBe(true)
    // A VMC that still publishes fallbacks has more than one channel.
    expect(routeLocked({ ...locked, fallbacks: ["baseten"] })).toBe(false)
    // No VMC at all means the router was free to choose.
    expect(routeLocked({ virtualModel: null, fallbacks: [] })).toBe(false)
  })
})
