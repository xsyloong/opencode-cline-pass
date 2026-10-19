import { describe, expect, it } from "vitest"
import { accountProfileFor, assertUsableApiKey, credentialName, maskKey } from "../src/accounts.js"
import type { AccountProfile } from "../src/types.js"

const profile = (ref: string, overrides: Partial<AccountProfile> = {}): AccountProfile => ({
  displayName: ref,
  apiKeyEnv: ref,
  enabled: true,
  baseURL: "",
  ...overrides,
})

describe("credential references", () => {
  it("allocates a distinct reference for every account spelling", () => {
    const accounts: Record<string, AccountProfile> = {}
    for (const name of ["foo.bar", "foo-bar", "foo_bar", "MAIN", "main"]) {
      accounts[name] = profile(credentialName(name, accounts))
    }
    const refs = Object.values(accounts).map((entry) => entry.apiKeyEnv)
    expect(new Set(refs).size).toBe(5)
    expect(accounts.main?.apiKeyEnv).toBe("CLINE_PASS_MAIN_KEY")
  })

  it("keeps the familiar reference for a simple lowercase id", () => {
    expect(credentialName("main", {})).toBe("CLINE_PASS_MAIN_KEY")
    expect(credentialName("backup", { main: profile("CLINE_PASS_MAIN_KEY") })).toBe("CLINE_PASS_BACKUP_KEY")
  })

  it("never reuses a reference already in the pool", () => {
    const first = credentialName("main", {})
    const second = credentialName("main", { other: profile(first) })
    expect(second).not.toBe(first)
    expect(second.startsWith("CLINE_PASS_MAIN_KEY__")).toBe(true)
  })
})

describe("account profiles", () => {
  it("applies only supplied fields when updating", () => {
    const existing = { backup: profile("REVIEW_CUSTOM", { baseURL: "http://backup", enabled: false }) }
    const next = accountProfileFor("backup", { key: "sk_new" } as any, existing, "DEFAULT")
    expect(next).toEqual({ ...profile("REVIEW_CUSTOM", { baseURL: "http://backup", enabled: false }) })
  })

  it("allocates defaults on creation", () => {
    const next = accountProfileFor("work", { displayName: "Work" }, {}, "DEFAULT")
    expect(next).toEqual({
      displayName: "Work",
      apiKeyEnv: "CLINE_PASS_WORK_KEY",
      enabled: true,
      baseURL: "",
    })
  })

  it("rejects names a config key cannot carry", () => {
    expect(() => accountProfileFor("bad name", {}, {})).toThrow(/may use letters/)
    expect(() => accountProfileFor("__proto__", {}, {})).toThrow(/__proto__/)
  })
})

describe("secrets", () => {
  it("masks without losing recognizability", () => {
    expect(maskKey("")).toBe("")
    expect(maskKey("short")).toBe("sh…rt")
    expect(maskKey("sk_abcdefghijklmnop")).toBe("sk_abc…mnop")
  })

  it("rejects blank and header-hostile keys", () => {
    expect(() => assertUsableApiKey("   ", "cline-pass", "REF")).toThrow(/blank/)
    expect(() => assertUsableApiKey("sk_bad key", "cline-pass", "REF")).toThrow(/whitespace/)
    expect(assertUsableApiKey("sk_good", "cline-pass", "REF")).toBe("sk_good")
  })
})
