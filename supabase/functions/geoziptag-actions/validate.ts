// Request validation straight from the manifest's params_schema (the contract), so no field is invented here.
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { fail } from './util.ts'

const ajv = new Ajv2020.default({ useDefaults: true, strict: false, allErrors: false })
;(addFormats as unknown as { default: (a: unknown) => void }).default(ajv)

// deno-lint-ignore no-explicit-any
type Schema = any
const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>()

/** Validates (and fills defaults into) `value`; unknown fields are rejected with 422 because the schemas say additionalProperties false. */
export function validate(schema: Schema, value: unknown): Record<string, unknown> {
  let fn = compiled.get(schema)
  if (!fn) compiled.set(schema, fn = ajv.compile(schema))
  if (!fn(value)) {
    const e = fn.errors![0]
    const where = e.instancePath
      ? e.instancePath.slice(1)
      : (e.params as { additionalProperty?: string }).additionalProperty
    throw fail(422, 'INVALID_PARAMS', `Invalid parameters${where ? ` (${where})` : ''}: ${e.message}`)
  }
  return value as Record<string, unknown>
}

/** A GET carries its params in the query string: turn them back into the types the schema declares. */
export function coerceQuery(schema: Schema, search: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key)
    if (values.length > 1) {
      throw fail(422, 'INVALID_PARAMS', `Invalid parameters (${key}): given more than once`)
    }
    const v = values[0]
    const t = schema?.properties?.[key]?.type
    out[key] = t === 'integer' && /^-?\d+$/.test(v)
      ? Number(v)
      : t === 'boolean' && (v === 'true' || v === 'false')
      ? v === 'true'
      : v
  }
  return out
}
