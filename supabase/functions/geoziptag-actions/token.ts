// Verifies a SoHum (Supabase Auth) access token against the sohum project's JWKS. Returns the account id (`sub`), or null
// for anything that does not verify (including a project that still signs with the legacy shared secret: that fails closed).
import { createRemoteJWKSet, jwtVerify } from 'jose'

export function sohumTokenVerifier(supabaseUrl: string): (token: string) => Promise<string | null> {
  const base = supabaseUrl.replace(/\/+$/, '')
  const jwks = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), {
    cooldownDuration: 60_000,
  })
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${base}/auth/v1`,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
      })
      return typeof payload.sub === 'string' && /^[0-9a-f-]{36}$/i.test(payload.sub)
        ? payload.sub.toLowerCase()
        : null
    } catch {
      return null
    }
  }
}
