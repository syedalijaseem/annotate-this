import { AnnotateError } from "../errors.js"
import { ID_PATTERN } from "../ids.js"
import { FORBIDDEN_KEYS } from "../schema/primitives.js"
import type { AnnotationBase } from "../types.js"
import type { AnnotationPatch, RegionPatch } from "./types.js"
import { deepEqual, withoutKeys } from "./util.js"

/** Optional scalar fields where `null` clears the value. */
const CLEARABLE = ["classId", "comment", "locked", "hidden", "parentId", "frame"] as const

type Fields = Record<string, unknown>

/** Keys of an attributes or meta patch must not be able to reach the prototype chain. */
export function assertSafePatchKeys(patch: RegionPatch): void {
  for (const key of Object.keys(patch.attributes ?? {})) {
    if (FORBIDDEN_KEYS.has(key) || !ID_PATTERN.test(key)) {
      throw new AnnotateError("INVALID_DOCUMENT", "patch: attribute keys must be valid ids")
    }
  }
  for (const key of Object.keys(patch.meta ?? {})) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new AnnotateError("INVALID_DOCUMENT", "patch: meta contains a forbidden key")
    }
  }
}

/** Merges `patch` (a map patch) into `current`; `undo` receives the old value of each changed key (`null` if absent). */
function mergeMap<V>(
  current: Record<string, V>,
  patch: Record<string, V | null>,
  undo: Record<string, V | null>,
): Record<string, V> | null {
  const sets: [string, V][] = []
  const drops = new Set<string>()
  for (const [key, value] of Object.entries(patch)) {
    const has = Object.hasOwn(current, key)
    if (value === null ? !has : has && deepEqual(current[key], value)) continue
    undo[key] = has ? (current[key] as V) : null
    if (value === null) drops.add(key)
    else sets.push([key, value])
  }
  if (sets.length === 0 && drops.size === 0) return null
  const next = withoutKeys(current, drops)
  for (const [key, value] of sets) next[key] = value
  return next
}

/**
 * Applies an annotation patch without mutating `entity`. Returns `null` when
 * nothing would change (a no-op), otherwise the new entity and the patch that
 * undoes it.
 */
export function applyAnnotationPatch<T extends AnnotationBase>(
  entity: T,
  patch: AnnotationPatch & { frame?: number | null },
): { next: T; undo: AnnotationPatch & { frame?: number | null } } | null {
  const next: Fields = { ...(entity as unknown as Fields) }
  const undo: Fields = {}
  const cleared = new Set<string>()
  const current = entity as unknown as Fields
  const wanted = patch as unknown as Fields

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
  if (patch.status !== undefined && patch.status !== entity.status) {
    next["status"] = patch.status
    undo["status"] = entity.status
  }
  if (patch.tagIds !== undefined && !deepEqual(patch.tagIds, entity.tagIds)) {
    next["tagIds"] = [...patch.tagIds]
    undo["tagIds"] = entity.tagIds
  }
  if (patch.attributes) {
    const attributeUndo = {}
    const merged = mergeMap(entity.attributes, patch.attributes, attributeUndo)
    if (merged) {
      next["attributes"] = merged
      undo["attributes"] = attributeUndo
    }
  }
  if (patch.meta) {
    const metaUndo = {}
    const merged = mergeMap(entity.meta, patch.meta, metaUndo)
    if (merged) {
      next["meta"] = merged
      undo["meta"] = metaUndo
    }
  }
  if (Object.keys(undo).length === 0) return null
  for (const key of cleared) Reflect.deleteProperty(next, key)
  return { next: next as unknown as T, undo: undo as AnnotationPatch & { frame?: number | null } }
}
