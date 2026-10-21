import { AnnotateError } from "../errors.js"
import type { AnnotationBase } from "../types.js"
import type { OpContext } from "./context.js"
import type { AnnotationPatch } from "./types.js"
import { deepEqual } from "./util.js"

// Optional scalar fields where `null` clears the value.
const CLEARABLE = ["classId", "comment", "locked", "hidden", "parentId", "frame"] as const

type Fields = Record<string, unknown>

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

function patchScalars(current: Fields, wanted: Fields, next: Fields, undo: Fields): Set<string> {
  const cleared = new Set<string>()
  for (const key of CLEARABLE) {
    const value = wanted[key]
    if (value === undefined) continue
    const old = current[key]
    if (value === null) {
      if (old === undefined) continue
      cleared.add(key)
      undo[key] = old
    } else if (!deepEqual(old, value)) {
      next[key] = value
      undo[key] = old ?? null
    }
  }
  return cleared
}

function patchMaps(
  ctx: OpContext,
  entity: AnnotationBase,
  patch: AnnotationPatch,
  next: Fields,
  undo: Fields,
) {
  for (const field of ["attributes", "meta"] as const) {
    const changes = patch[field]
    if (!changes) continue
    const fieldUndo = {}
    const merged = mergeMap<unknown>(ctx, entity[field], changes, fieldUndo)
    if (merged) {
      next[field] = merged
      undo[field] = fieldUndo
    }
  }
}

// Applies an annotation patch without mutating `entity`. Returns `null` when
// nothing would change (a no-op), otherwise the new entity and the patch that
// undoes it. The patch must already be parsed (op-schema.ts).
export function applyAnnotationPatch<T extends AnnotationBase>(
  ctx: OpContext,
  entity: T,
  patch: AnnotationPatch & { frame?: number | null },
): { next: T; undo: AnnotationPatch & { frame?: number | null } } | null {
  const next: Fields = { ...(entity as unknown as Fields) }
  const undo: Fields = {}
  const cleared = patchScalars(entity as unknown as Fields, patch as Fields, next, undo)
  if (patch.status !== undefined && patch.status !== entity.status) {
    next["status"] = patch.status
    undo["status"] = entity.status
  }
  if (patch.tagIds !== undefined && !deepEqual(patch.tagIds, entity.tagIds)) {
    next["tagIds"] = [...patch.tagIds]
    undo["tagIds"] = entity.tagIds
  }
  patchMaps(ctx, entity, patch, next, undo)
  if (Object.keys(undo).length === 0) return null
  for (const key of cleared) Reflect.deleteProperty(next, key)
  return { next: next as unknown as T, undo: undo as AnnotationPatch & { frame?: number | null } }
}
