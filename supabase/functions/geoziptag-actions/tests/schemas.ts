// Validates values against the pinned contract schemas (copied to tests/contract/ from sohum-contracts 0a2a17c).
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

const dir = new URL('./contract/', import.meta.url)
export const ajv = new Ajv2020.default({ strict: false, allErrors: true })
;(addFormats as unknown as { default: (a: unknown) => void }).default(ajv)

const ids: Record<string, string> = {}
for (const f of Deno.readDirSync(dir)) {
  if (!f.name.endsWith('.schema.json')) continue
  const schema = JSON.parse(Deno.readTextFileSync(new URL(f.name, dir)))
  ajv.addSchema(schema)
  ids[f.name.replace(/^sohum-geoziptag-/, '').replace('.schema.json', '')] = schema.$id
}

export type Shape =
  | 'entitlement'
  | 'entitlement#payload'
  | 'entitlement#signed'
  | 'entitlement#public_keys'
  | 'redeem_code'
  | 'redeem_code#created'
  | 'redemption'
  | 'team_plan'
  | 'team_member'

/** Returns the schema errors (empty when the value is valid). */
export function errorsFor(shape: Shape, value: unknown): string[] {
  const [file, def] = shape.split('#')
  const ref = def ? `${ids[file.replace('_', '-')]}#/$defs/${def}` : ids[file.replace('_', '-')]
  const fn = ajv.getSchema(ref)
  if (!fn) throw new Error(`no schema for ${shape}`)
  return fn(value) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

export function readContractJson(name: string) {
  return JSON.parse(Deno.readTextFileSync(new URL(name, dir)))
}
