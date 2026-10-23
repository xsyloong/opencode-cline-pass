import { describe, expect, it } from "vitest"
import { catalogEntry, resolveModelMetadata } from "../src/catalog.js"

const DATED = "cline-pass/deepseek-v4.1-flash-1017"
const BASE = "cline-pass/deepseek-v4.1-flash"

describe("dated model snapshots", () => {
  it("inherit the base model's context, output, reasoning and modalities", () => {
    const base = catalogEntry(BASE)!
    const dated = catalogEntry(DATED)!
    expect(dated).toMatchObject({
      name: "DeepSeek V4.1 Flash (1017)",
      contextWindow: base.contextWindow,
      maxTokens: base.maxTokens,
      reasoning: true,
      input: base.input,
    })
    expect(dated.contextWindow).toBe(1_000_000)
  })

  it("resolves the dated snapshot against the generic fallback", () => {
    const resolved = resolveModelMetadata(
      "cline-pass",
      DATED,
      {},
      { contextWindow: 128_000, maxTokens: 64_000, reasoning: false },
    )
    expect(resolved.name).toBe("DeepSeek V4.1 Flash (1017)")
    expect(resolved.context.contextWindow).toBe(1_000_000)
    expect(resolved.defaultMaxTokens).toBe(64_000)
  })
})

describe("open-pool slugs", () => {
  it("resolves a vendor slug to the same published facts as its subscription id", () => {
    const slug = catalogEntry("deepseek/deepseek-v4.1-flash-1017")!
    const dated = catalogEntry(DATED)!
    expect(slug).toMatchObject({
      name: dated.name,
      contextWindow: dated.contextWindow,
      maxTokens: dated.maxTokens,
      reasoning: true,
    })
    expect(slug.contextWindow).toBe(1_000_000)
  })

  it("keeps the alias entry's own name instead of mangling its suffix", () => {
    const alias = catalogEntry("cline-pass/deepseek-v4.1-flash-1017-open")!
    expect(alias.name).toBe("DeepSeek V4.1 Flash 1017 (open pool · billed)")
    expect(alias.contextWindow).toBe(1_000_000)
  })
})
