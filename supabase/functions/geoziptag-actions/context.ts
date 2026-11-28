import type { Signer } from './signing.ts'
import type { Store, Tx } from './store.ts'

export const VERSION = '0.1.0'

/** Everything the function reads from the environment, by name only (see README). Missing pieces are undefined. */
export interface Config {
  consoleSecret?: string // GEOZIPTAG_CONSOLE_SECRET
  pepper?: string // GEOZIPTAG_CODE_PEPPER
  signer?: Signer // GEOZIPTAG_SIGNING_KEY + GEOZIPTAG_SIGNING_KEY_ID
  publicKeys?: { schema: string; keys: unknown[] } // GEOZIPTAG_PUBLIC_KEYS
}

export interface Deps {
  store: Store
  config: Config
  /** Verifies a SoHum (Supabase Auth) bearer token; returns the account id (`sub`) or null. */
  verifyToken: (token: string) => Promise<string | null>
  now?: () => Date
}

export interface Ctx {
  tx: Tx
  now: Date
  actor: string
  role: string
  requestId: string
  config: Config
}

export type Params = Record<string, unknown>
