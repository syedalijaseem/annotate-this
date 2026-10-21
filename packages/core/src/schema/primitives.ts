import {
  type GenericSchema,
  array,
  boolean,
  finite,
  integer,
  isoTimestamp,
  lazy,
  maxLength,
  maxValue,
  minValue,
  null as nullSchema,
  number,
  pipe,
  rawCheck,
  record,
  regex,
  string,
  transform,
  union,
  unknown,
} from "valibot"
import { ID_PATTERN } from "../ids.js"
import type { AttributeValue, ID, JSONValue } from "../types.js"

/** Keys that must never appear in user-keyed records. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

/** Hard cap on short config lists (statuses, tools, enum options), which are searched per annotation. */
export const MAX_LIST_LENGTH = 1000

/** Hard cap on mask run counts: bounds memory before the pixel-sum check runs. */
export const MAX_MASK_RUNS = 4_000_000

/** Hard cap on one flat coordinate array: bounds work before the configurable vertex limits run. */
export const MAX_COORDINATES = 8_000_000

/** Hard cap on the length of a custom geometry kind ("vendor:name"). */
export const MAX_CUSTOM_KIND_LENGTH = 256

/** Record keys need a string-input schema (record() constrains the key's input type). */
const KeySchema = pipe(string(), regex(ID_PATTERN))

export const IdSchema: GenericSchema<unknown, ID> = KeySchema

export const NumSchema: GenericSchema<unknown, number> = pipe(number(), finite())
export const NonNegativeSchema: GenericSchema<unknown, number> = pipe(
  number(),
  finite(),
  minValue(0),
)
export const IntSchema: GenericSchema<unknown, number> = pipe(
  number(),
  integer(),
  minValue(0),
  maxValue(Number.MAX_SAFE_INTEGER),
)
/** Entity revision counter (Spec 0001). */
export const RevSchema: GenericSchema<unknown, number> = IntSchema
export const PositiveIntSchema: GenericSchema<unknown, number> = pipe(
  number(),
  integer(),
  minValue(1),
  maxValue(Number.MAX_SAFE_INTEGER),
)

/** Free text. Length limits beyond this hard cap are enforced by the configurable limits pass. */
export const TextSchema: GenericSchema<unknown, string> = pipe(string(), maxLength(1_000_000))
export const TimestampSchema: GenericSchema<unknown, string> = pipe(string(), isoTimestamp())
export const ColorSchema: GenericSchema<unknown, string> = pipe(
  string(),
  regex(/^#[0-9a-fA-F]{6}$/),
)

function rejectForbiddenKeys(): ReturnType<typeof rawCheck<unknown>> {
  return rawCheck(({ dataset, addIssue }) => {
    const input = dataset.value
    if (Array.isArray(input)) {
      addIssue({ message: "Expected an object but received an array" })
      return
    }
    if (typeof input !== "object" || input === null) return
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_KEYS.has(key)) addIssue({ message: `Forbidden key "${key}"` })
    }
  })
}

/** Names like "toString" must never resolve through the prototype chain. */
const withoutPrototype = <V>(value: Record<string, V>): Record<string, V> =>
  Object.assign(Object.create(null) as Record<string, V>, value)

/**
 * A record keyed by IDs. Valibot (like Zod) silently *drops* an own `__proto__`
 * key, which is safe but hides an attack; this checks the raw input first and
 * reports it. Keys must match the ID pattern and the result has no prototype.
 */
export function safeRecord<V>(
  value: GenericSchema<unknown, V>,
): GenericSchema<unknown, Record<string, V>> {
  return pipe(
    unknown(),
    rejectForbiddenKeys(),
    record(KeySchema, value),
    transform(withoutPrototype),
  )
}

/** A record of free-form JSON: any key text is fine except the forbidden ones. */
function jsonRecord<V>(
  value: GenericSchema<unknown, V>,
): GenericSchema<unknown, Record<string, V>> {
  return pipe(
    unknown(),
    rejectForbiddenKeys(),
    record(string(), value),
    transform(withoutPrototype),
  )
}

const JsonScalarSchema = union([string(), NumSchema, boolean(), nullSchema()])
const JsonArraySchema = array(lazy(() => JsonValueSchema))
const JsonObjectSchema = jsonRecord(lazy(() => JsonValueSchema))

/**
 * Picks one branch from the input's type. A plain union would try every branch
 * on every level, and an array also passes record()'s object check, so a bad
 * leaf nested n levels deep would cost 2^n work.
 */
const JsonValueSchema: GenericSchema<unknown, JSONValue> = lazy((input) => {
  if (Array.isArray(input)) return JsonArraySchema
  if (typeof input === "object" && input !== null) return JsonObjectSchema
  return JsonScalarSchema
})

export const MetaSchema = jsonRecord(JsonValueSchema)
export const JsonSchema = JsonValueSchema

export const AttributeValueSchema: GenericSchema<unknown, AttributeValue> = union([
  TextSchema,
  NumSchema,
  boolean(),
])
export const AttributesSchema = safeRecord(AttributeValueSchema)
