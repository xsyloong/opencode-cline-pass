/**
 * The account pool: account profiles, credential resolution, single/round-robin
 * selection, and cooldown after an account-level refusal.
 */
import { assertUsableApiKey, maskKey } from "./accounts.js"
import type { ConfigStore } from "./config.js"
import { ClinePassError, errorChain, QUOTA_EXCEEDED_CODE, AUTH_CODE } from "./errors.js"
import type { Logger } from "./log.js"
import type { AccountProfile, AccountView, PluginConfig, ResolvedAccount, UsageAccount } from "./types.js"

/** How long one failure keeps an account out of the pool. */
export const COOLDOWN_MS: Record<string, number> = {
  [QUOTA_EXCEEDED_CODE]: 15 * 60_000,
  [AUTH_CODE]: 30 * 60_000,
}

export interface AccountPoolOptions {
  config: () => PluginConfig
  store: ConfigStore
  logger: Logger
  now?: () => number
}

/** One account candidate: name, profile, resolved key. */
type Candidate = [string, AccountProfile, string]

export class AccountPool {
  private readonly config: () => PluginConfig
  private readonly store: ConfigStore
  private readonly logger: Logger
  private readonly now: () => number
  private roundRobin = 0
  /** name -> cooldown expiry timestamp */
  private readonly cooling = new Map<string, number>()

  constructor(options: AccountPoolOptions) {
    this.config = options.config
    this.store = options.store
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  /**
   * Resolve the configured accounts.
   *
   * An empty `accounts` dictionary means one implicit account on the top-level
   * fields, so a fresh install works as soon as `CLINE_PASS_API_KEY` exists.
   */
  accountProfiles(): Array<[string, AccountProfile]> {
    const cfg = this.config()
    const declared = Object.entries(cfg.accounts ?? {})
    if (declared.length === 0) {
      return [
        [
          "default",
          {
            displayName: cfg.displayName,
            apiKeyEnv: cfg.apiKeyEnv,
            enabled: true,
            baseURL: cfg.baseURL,
          },
        ],
      ]
    }
    return declared.map(([key, profile]) => [
      key,
      {
        displayName: String(profile?.displayName ?? "") || key,
        apiKeyEnv: String(profile?.apiKeyEnv || cfg.apiKeyEnv),
        enabled: profile?.enabled !== false,
        baseURL: String(profile?.baseURL ?? "") || cfg.baseURL,
      },
    ])
  }

  /** The credential reference behind one account name. */
  credentialRef(name: string): string {
    const found = this.accountProfiles().find(([key]) => key === name)
    return found?.[1].apiKeyEnv ?? this.config().apiKeyEnv
  }

  /**
   * The enabled accounts in the order the router would consider them.
   *
   * Accounts that just refused a request are stood down for a while, so a pool
   * does not spend one failed round trip per call rediscovering the same
   * exhausted key. When every candidate is cooling the oldest one is used
   * anyway: a window can reset, and refusing to try at all would be worse.
   */
  async candidateAccounts(exclude: string[] = []): Promise<{ ordered: Candidate[]; error?: Error }> {
    const skip = new Set(exclude.map(String))
    const failures: Error[] = []
    const enabled = this.accountProfiles().filter(([key, profile]) => profile.enabled && !skip.has(key))
    const resolved = await Promise.all(
      enabled.map(async ([key, profile]): Promise<Candidate | undefined> => {
        try {
          const value = await this.store.resolveCredential(profile.apiKeyEnv)
          if (value === undefined) {
            throw new ClinePassError(
              `cline-pass: no API key for account "${key}"; store it at ${profile.apiKeyEnv} or configure another account`,
              "MISSING_CREDENTIAL",
            )
          }
          return [key, profile, assertUsableApiKey(value, "cline-pass", profile.apiKeyEnv)]
        } catch (error) {
          failures.push(
            error instanceof ClinePassError
              ? error
              : new ClinePassError(
                  `cline-pass: the API key for account "${key}" cannot be used: ${errorChain(error)}`,
                  "INVALID_CREDENTIAL",
                  { cause: error },
                ),
          )
          return undefined
        }
      }),
    )
    const usable = resolved.filter((entry): entry is Candidate => entry !== undefined)
    const now = this.now()
    const eligible = usable.filter(([key]) => (this.cooling.get(key) ?? 0) <= now)
    if (eligible.length > 0) return { ordered: eligible, error: failures[0] }
    const pool = [...usable].sort((left, right) => (this.cooling.get(left[0]) ?? 0) - (this.cooling.get(right[0]) ?? 0))
    return { ordered: pool, error: failures[0] }
  }

  /**
   * The account the next request would use, without consuming a round-robin
   * turn. Reading quota is not a request that advances the cursor.
   */
  async effectiveAccount(): Promise<string> {
    const cfg = this.config()
    const { ordered } = await this.candidateAccounts()
    if (ordered.length === 0) return ""
    if (cfg.accountMode === "roundrobin" && ordered.length > 1) {
      return ordered[this.roundRobin % ordered.length]![0]
    }
    return (ordered.find(([key]) => key === cfg.activeAccount) ?? ordered[0])![0]
  }

  /** Pick the account for the next request and resolve its key. */
  async resolveAccount(options: { exclude?: string[] } = {}): Promise<ResolvedAccount | undefined> {
    const exclude = options.exclude ?? []
    const cfg = this.config()
    const enabled = this.accountProfiles().filter(([, profile]) => profile.enabled)
    if (enabled.length === 0) {
      throw new ClinePassError(
        "cline-pass: every configured account is disabled; enable one or add another",
        "MISSING_CREDENTIAL",
      )
    }
    const { ordered, error } = await this.candidateAccounts(exclude)
    if (ordered.length === 0) {
      if (exclude.length > 0) return undefined
      throw (
        error ??
        new ClinePassError("cline-pass: no usable account credentials", "MISSING_CREDENTIAL")
      )
    }
    let picked: Candidate
    if (cfg.accountMode === "roundrobin" && ordered.length > 1) {
      picked = ordered[this.roundRobin % ordered.length]!
      this.roundRobin = (this.roundRobin + 1) % 1_000_000_000
    } else {
      picked = ordered.find(([key]) => key === cfg.activeAccount) ?? ordered[0]!
    }
    const [name, profile, key] = picked
    return { name, key, baseURL: profile.baseURL || cfg.baseURL }
  }

  /**
   * Every enabled account a management call can speak for, with its key
   * resolved. Quota is PER ACCOUNT, so a reading has to name the account it
   * belongs to.
   */
  async usageAccounts(): Promise<UsageAccount[]> {
    const cfg = this.config()
    const enabled = this.accountProfiles().filter(([, profile]) => profile.enabled)
    return await Promise.all(
      enabled.map(async ([name, profile]) => {
        const key = await this.store.resolveCredential(profile.apiKeyEnv).catch(() => undefined)
        return {
          name,
          displayName: profile.displayName,
          key: key ?? "",
          keyConfigured: key !== undefined,
          baseURL: profile.baseURL || cfg.baseURL,
        }
      }),
    )
  }

  /** All accounts, without keys. */
  accounts(): Array<AccountView & { declared: boolean }> {
    const cfg = this.config()
    const declared = new Set(Object.keys(cfg.accounts ?? {}))
    return this.accountProfiles().map(([key, profile]) => ({
      key,
      displayName: profile.displayName,
      apiKeyEnv: profile.apiKeyEnv,
      enabled: profile.enabled,
      baseURL: profile.baseURL,
      declared: declared.has(key),
      keyConfigured: false,
      keyHint: "",
    }))
  }

  /** All accounts with their stored-key state and a masked hint. */
  async accountsWithKeys(): Promise<Array<AccountView & { declared: boolean }>> {
    const cfg = this.config()
    const declared = new Set(Object.keys(cfg.accounts ?? {}))
    return await Promise.all(
      this.accountProfiles().map(async ([key, profile]) => {
        const value = await this.store.resolveCredential(profile.apiKeyEnv).catch(() => undefined)
        return {
          key,
          displayName: profile.displayName,
          apiKeyEnv: profile.apiKeyEnv,
          enabled: profile.enabled,
          baseURL: profile.baseURL,
          declared: declared.has(key),
          keyConfigured: value !== undefined,
          keyHint: maskKey(value),
        }
      }),
    )
  }

  /**
   * Stand one account down after an account-level refusal.
   * @returns the cooldown in milliseconds, or 0 when the code is not account-level.
   */
  markCooling(account: string | null | undefined, code: string): number {
    const wait = COOLDOWN_MS[code]
    if (account === undefined || account === null || account === "" || wait === undefined) return 0
    this.cooling.set(account, this.now() + wait)
    this.logger.warn(
      '[cline-pass] account "%s" stood down for %ds after %s; the pool will use another account',
      account,
      Math.round(wait / 1000),
      code,
    )
    return wait
  }

  /** Current cooldown expiries, for diagnostics. */
  coolingSnapshot(): Record<string, number> {
    return Object.fromEntries(this.cooling)
  }
}
