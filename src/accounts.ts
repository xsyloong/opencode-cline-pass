/** Account edits shared by the dashboard and management tools. */
import type { AccountProfile } from "./types.js"

/**
 * Allocate a stable credential reference without folding distinct account names
 * together. Simple lowercase ids keep the familiar name; anything else carries
 * the exact bytes in hex so case and punctuation remain distinct.
 */
export function credentialName(name: string, accounts: Record<string, AccountProfile>): string {
  const stem = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  const base = `CLINE_PASS_${stem}_KEY`
  const used = new Set(
    Object.entries(accounts)
      .filter(([key]) => key !== name)
      .map(([, entry]) => String(entry?.apiKeyEnv ?? "")),
  )
  const encoded = `${base}__${Buffer.from(name).toString("hex").toUpperCase()}`
  let ref = /^[a-z0-9_]+$/.test(name) && !used.has(base) ? base : encoded
  for (let suffix = 2; used.has(ref); suffix += 1) ref = `${encoded}_${suffix}`
  return ref
}

/**
 * Apply only supplied fields when updating; allocate defaults on creation.
 * Key rotation therefore preserves every other field of the account.
 */
export function accountProfileFor(
  name: string,
  changes: Partial<AccountProfile> | undefined,
  accounts: Record<string, AccountProfile>,
  defaultRef = "",
): AccountProfile {
  if (
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name === "__proto__" ||
    name === "constructor" ||
    name === "prototype"
  ) {
    throw new Error(
      "the account name may use letters, digits, dot, dash and underscore only (except __proto__, constructor and prototype)",
    )
  }
  const existing = Object.hasOwn(accounts, name) ? accounts[name] : undefined
  const previous: Partial<AccountProfile> = existing ?? {}
  const suppliedRef = String(changes?.apiKeyEnv ?? "").trim()
  const priorRef = String(previous.apiKeyEnv ?? "").trim() || (existing === undefined ? "" : String(defaultRef))
  return {
    displayName:
      changes?.displayName === undefined
        ? String(previous.displayName ?? "") || name
        : String(changes.displayName).trim() || name,
    apiKeyEnv: suppliedRef || priorRef || credentialName(name, accounts),
    enabled: changes?.enabled === undefined ? previous.enabled !== false : changes.enabled !== false,
    baseURL:
      changes?.baseURL === undefined ? String(previous.baseURL ?? "") : String(changes.baseURL ?? "").trim(),
  }
}

/** Mask a secret, keeping just enough to recognize it. */
export function maskKey(value: unknown): string {
  const key = String(value ?? "")
  if (key.length === 0) return ""
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/**
 * Validate that a key can actually ride an HTTP header.
 * @throws when blank or carrying characters no header can hold.
 */
export function assertUsableApiKey(raw: unknown, pkg: string, ref: string): string {
  const value = String(raw ?? "").trim()
  if (value.length === 0) {
    throw new Error(
      `${pkg}: the API key resolved from ${ref} is blank; store it with cline_pass_accounts or export ${ref}`,
    )
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new Error(
      `${pkg}: the API key resolved from ${ref} contains whitespace or control characters no HTTP header can carry; store the raw key alone`,
    )
  }
  return value
}
