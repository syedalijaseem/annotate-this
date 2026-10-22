import {
  type GenericSchema,
  boolean,
  check,
  finite,
  integer,
  maxLength,
  maxValue,
  minValue,
  number,
  pipe,
  rawCheck,
  rawTransform,
  record,
  regex,
  string,
  transform,
  union,
  unknown,
} from "valibot"
import { ID_PATTERN_SOURCE } from "../ids.js"
import type { AttributeValue, ID, JSONValue } from "../types.js"

// Keys that must never appear in user-keyed records. Module-private: a Set cannot be frozen.
const FORBIDDEN_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "__proto__",
  "constructor",
  "prototype",
])

/** Whether `key` must never appear in a user-keyed record (prototype pollution). */
export const isForbiddenKey = (key: string): boolean => FORBIDDEN_KEYS.has(key)

/** Hard cap on short config lists (statuses, tools, enum options), which are searched per annotation. */
export const MAX_LIST_LENGTH = 1000

/** Hard cap on mask run counts: bounds memory before the pixel-sum check runs. */
export const MAX_MASK_RUNS = 4_000_000

/** Hard cap on one flat coordinate array: bounds work before the configurable vertex limits run. */
export const MAX_COORDINATES = 8_000_000

/** Hard cap on the length of a custom geometry kind ("vendor:name"). */
export const MAX_CUSTOM_KIND_LENGTH = 256

/**
 * `{ ...a, ...b }` for schema entry tables. A spread at module level counts as
 * a side effect to bundlers; this call does not, so unused schemas tree-shake.
 */
/* @__NO_SIDE_EFFECTS__ */
export function merge<A extends object, B extends object>(a: A, b: B): A & B {
  return { ...a, ...b }
}

// Number.MAX_SAFE_INTEGER and Number.EPSILON as literals: bundlers treat a
// global property read at module level as a possible side effect.
const MAX_SAFE_INTEGER = 9_007_199_254_740_991
export const EPSILON = 2.220446049250313e-16

/** Record keys need a string-input schema (record() constrains the key's input type). */
// A private RegExp instance: nothing outside this module can recompile it.
const KeySchema = /* @__PURE__ */ pipe(
  /* @__PURE__ */ string(),
  /* @__PURE__ */ regex(/* @__PURE__ */ new RegExp(ID_PATTERN_SOURCE)),
)

export const IdSchema: GenericSchema<unknown, ID> = KeySchema

export const NumSchema: GenericSchema<unknown, number> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ number(),
  /* @__PURE__ */ finite(),
)
export const NonNegativeSchema: GenericSchema<unknown, number> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ number(),
  /* @__PURE__ */ finite(),
  /* @__PURE__ */ minValue(0),
)
export const IntSchema: GenericSchema<unknown, number> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ number(),
  /* @__PURE__ */ integer(),
  /* @__PURE__ */ minValue(0),
  /* @__PURE__ */ maxValue(MAX_SAFE_INTEGER),
)
/** Entity revision counter (Spec 0001). */
export const RevSchema: GenericSchema<unknown, number> = IntSchema
export const PositiveIntSchema: GenericSchema<unknown, number> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ number(),
  /* @__PURE__ */ integer(),
  /* @__PURE__ */ minValue(1),
  /* @__PURE__ */ maxValue(MAX_SAFE_INTEGER),
)

/** Free text. Length limits beyond this hard cap are enforced by the configurable limits pass. */
export const TextSchema: GenericSchema<unknown, string> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ string(),
  /* @__PURE__ */ maxLength(1_000_000),
)
// ISO-8601 UTC (Spec 0001): seconds required, an optional 1 to 9 digit fraction, "Z".
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/

/** True for an ISO-8601 UTC timestamp that names a real instant (no day or hour rollover). */
export function isUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match
    .slice(1)
    .map(Number)
  if (year === 0 || hour > 23 || minute > 59 || second > 59) return false
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export const TimestampSchema: GenericSchema<unknown, string> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ string(),
  /* @__PURE__ */ check(
    isUtcTimestamp,
    "Expected an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)",
  ),
)
export const ColorSchema: GenericSchema<unknown, string> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ string(),
  /* @__PURE__ */ regex(/^#[0-9a-fA-F]{6}$/),
)

/* @__NO_SIDE_EFFECTS__ */
function rejectForbiddenKeys(): ReturnType<typeof rawCheck<unknown>> {
  return /* @__PURE__ */ rawCheck(({ dataset, addIssue }) => {
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
/* @__NO_SIDE_EFFECTS__ */
export function safeRecord<V>(
  value: GenericSchema<unknown, V>,
): GenericSchema<unknown, Record<string, V>> {
  return /* @__PURE__ */ pipe(
    /* @__PURE__ */ unknown(),
    rejectForbiddenKeys(),
    /* @__PURE__ */ record(KeySchema, value),
    /* @__PURE__ */ transform(withoutPrototype),
  )
}

/** Deepest free-form JSON the copy below accepts; the configurable depth limits are far lower. */
const MAX_JSON_DEPTH = 10_000

const isJsonScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value))

type JsonContainer = JSONValue[] | { [key: string]: JSONValue }

interface JsonPending {
  source: object
  target: JsonContainer
  depth: number
}

/** Queues a container child and returns its empty copy, or an error message. */
function containerCopy(child: object, depth: number, stack: JsonPending[]): JsonContainer | string {
  if (depth > MAX_JSON_DEPTH) return "Nesting is too deep"
  const target: JsonContainer = Array.isArray(child) ? [] : Object.create(null)
  stack.push({ source: child, target, depth })
  return target
}

/** The copy of one member value, or an error message. */
function memberCopy(
  value: unknown,
  depth: number,
  stack: JsonPending[],
): { copy: unknown } | string {
  if (isJsonScalar(value)) return { copy: value }
  if (typeof value !== "object" || value === null) return "Expected a JSON value"
  const copy = containerCopy(value, depth + 1, stack)
  return typeof copy === "string" ? copy : { copy }
}

/** Copies one container's members; returns an error message for a forbidden key or non-JSON value. */
function copyMembers({ source, target, depth }: JsonPending, stack: JsonPending[]): string | null {
  if (Array.isArray(source)) {
    for (const value of source as unknown[]) {
      const member = memberCopy(value, depth, stack)
      if (typeof member === "string") return member
      ;(target as unknown[]).push(member.copy)
    }
    return null
  }
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden key "${key}"`
    const member = memberCopy((source as Record<string, unknown>)[key], depth, stack)
    if (typeof member === "string") return member
    ;(target as Record<string, unknown>)[key] = member.copy
  }
  return null
}

/**
 * Validates free-form JSON and copies it with null-prototype records. Iterative
 * and schema-free: valibot's record() costs about 2 µs per key, this a fraction.
 * Forbidden keys (prototype pollution) are reported, like safeRecord does.
 */
function copyJson(input: unknown, objectOnly: boolean): { value: JSONValue } | { error: string } {
  if (objectOnly && (typeof input !== "object" || input === null || Array.isArray(input))) {
    return { error: "Expected an object" }
  }
  const stack: JsonPending[] = []
  const root = memberCopy(input, 0, stack)
  if (typeof root === "string") return { error: root }
  for (let next = stack.pop(); next; next = stack.pop()) {
    const error = copyMembers(next, stack)
    if (error !== null) return { error }
  }
  return { value: root.copy as JSONValue }
}

/* @__NO_SIDE_EFFECTS__ */
function jsonSchema<T extends JSONValue>(objectOnly: boolean): GenericSchema<unknown, T> {
  return /* @__PURE__ */ pipe(
    /* @__PURE__ */ unknown(),
    /* @__PURE__ */ rawTransform(({ dataset, addIssue, NEVER }) => {
      const result = copyJson(dataset.value, objectOnly)
      if ("error" in result) {
        addIssue({ message: result.error })
        return NEVER
      }
      return result.value as T
    }),
  )
}

export const MetaSchema: GenericSchema<unknown, Record<string, JSONValue>> = jsonSchema(true)
export const JsonSchema: GenericSchema<unknown, JSONValue> = jsonSchema(false)

export const AttributeValueSchema: GenericSchema<unknown, AttributeValue> = /* @__PURE__ */ union([
  TextSchema,
  NumSchema,
  /* @__PURE__ */ boolean(),
])
export const AttributesSchema = safeRecord(AttributeValueSchema)
