// Supabase edge function entry: geoziptag-actions. Reads its configuration from the environment by name only.
//   Provided by Supabase: SUPABASE_URL, SUPABASE_DB_URL
//   Set by the owner (function secrets): GEOZIPTAG_SIGNING_KEY, GEOZIPTAG_SIGNING_KEY_ID, GEOZIPTAG_PUBLIC_KEYS,
//   GEOZIPTAG_CONSOLE_SECRET, GEOZIPTAG_CODE_PEPPER
import { createHandler } from './handler.ts'
import { pgStore } from './pg_store.ts'
import { makeSigner } from './signing.ts'
import { sohumTokenVerifier } from './token.ts'
import type { Config, Deps } from './context.ts'

const env = (name: string) => Deno.env.get(name) || undefined

function loadConfig(): Config {
  const keyId = env('GEOZIPTAG_SIGNING_KEY_ID')
  const key = env('GEOZIPTAG_SIGNING_KEY')
  let publicKeys: Config['publicKeys']
  const raw = env('GEOZIPTAG_PUBLIC_KEYS')
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      publicKeys = Array.isArray(parsed) ? { schema: 'sohum.geoziptag.public_keys/1', keys: parsed } : parsed
    } catch { /* left unset: get_public_keys answers 503 */ }
  }
  return {
    consoleSecret: env('GEOZIPTAG_CONSOLE_SECRET'),
    pepper: env('GEOZIPTAG_CODE_PEPPER'),
    signer: key && keyId ? makeSigner(key, keyId) : undefined,
    publicKeys,
  }
}

// Built on first use, so /health and /manifest answer even if the database is down.
let handler: ((req: Request) => Promise<Response>) | undefined
function get(): (req: Request) => Promise<Response> {
  if (!handler) {
    const dbUrl = env('SUPABASE_DB_URL')
    const url = env('SUPABASE_URL')
    const deps: Deps = {
      config: loadConfig(),
      store: dbUrl ? pgStore(dbUrl) : { tx: () => Promise.reject(new Error('SUPABASE_DB_URL is not set')) },
      verifyToken: url ? sohumTokenVerifier(url) : () => Promise.resolve(null),
    }
    handler = createHandler(deps)
  }
  return handler
}

Deno.serve((req) => get()(req))
