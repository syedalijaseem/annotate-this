import { AnnotateError } from "../errors.js"
import type { OpContext } from "./context.js"
import { deepEqual } from "./util.js"

type Fields = Record<string, unknown>

// Patch fields that merge key by key (`null` deletes a key) instead of replacing the value.
const MAP_FIELDS: ReadonlySet<string> = new Set(["attributes", "meta"])

// Merges a map patch (`null` deletes a key) into `current` without editing it.
// Returns `null` when nothing changes; `undo` receives the old value of each
// changed key (`null` if it was absent). The result is a null-prototype record
// and may not exceed `maxEntries` keys (parseDocument's per-object limit).
export function mergeMap<V>(
  ctx: OpContext,
  current: Record<string, V>,
  patch: Record<string, V | null>,
  undo: Record<string, V | null>,
): Record<string, V> | null {
  const keys = Object.keys(patch)
  ctx.charge(keys.length)
  const sets: [string, V][] = []
  const drops = new Set<string>()
  for (const key of keys) {
    const value = patch[key] as V | null
    const has = Object.hasOwn(current, key)
    if (value === null ? !has : has && deepEqual(current[key], value)) continue
    undo[key] = has ? (current[key] as V) : null
    if (value === null) drops.add(key)
    else sets.push([key, value])
  }
  if (sets.length === 0 && drops.size === 0) return null
  const existing = Object.keys(current)
  ctx.charge(existing.length)
  const next = Object.create(null) as Record<string, V>
  for (const key of existing) if (!drops.has(key)) next[key] = current[key] as V
  for (const [key, value] of sets) next[key] = value
  if (existing.length - drops.size + sets.length > ctx.limits.maxEntries) {
    throw new AnnotateError("LIMIT_EXCEEDED", `patch: more than ${ctx.limits.maxEntries} keys`)
  }
  return next
}

// Applies a parsed patch (op-schema.ts decides which fields may appear and
// which may be null) to any entity without mutating it: absent = unchanged,
// `null` = clear, `attributes`/`meta` merge per key, anything else is replaced.
// Returns `null` for a no-op, otherwise the new entity and the patch that undoes it.
export function applyPatch<T extends object>(
  ctx: OpContext,
  entity: T,
  patch: object,
): { next: T; undo: Fields } | null {
  const current = entity as Fields
  const next: Fields = { ...current }
  const undo: Fields = {}
  for (const [key, value] of Object.entries(patch)) {
    const old = Object.hasOwn(current, key) ? current[key] : undefined
    if (MAP_FIELDS.has(key)) {
      const fieldUndo: Fields = {}
      const merged = mergeMap(ctx, (old ?? {}) as Fields, value as Fields, fieldUndo)
      if (merged) {
        next[key] = merged
        undo[key] = fieldUndo
      }
    } else if (value === null) {
      if (old === undefined) continue
      Reflect.deleteProperty(next, key)
      undo[key] = old
    } else if (!deepEqual(old, value)) {
      next[key] = value
      undo[key] = old ?? null
    }
  }
  return Object.keys(undo).length > 0 ? { next: next as T, undo } : null
}
