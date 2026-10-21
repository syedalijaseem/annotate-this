import type { ID } from "../types.js"
import type { Position } from "./types.js"

/** Structural equality for JSON-like values. Recursion depth is bounded by the document depth limits. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false
  }
  return true
}

/**
 * Deterministic id for an inverse operation (FNV-1a, 64-bit, hex): `apply` must
 * stay pure, so inverses cannot draw random ids, and ids must stay unique per
 * source operation for the idempotency window.
 */
export function deriveId(sourceId: ID, index: number): ID {
  let hash = 0xcbf29ce484222325n
  for (const char of `inverse:${index}:${sourceId}`) {
    hash ^= BigInt(char.codePointAt(0) ?? 0)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `inv-${hash.toString(16).padStart(16, "0")}`
}

/** Position that puts `id` back where it is in `order` (bottom-to-top). */
export function positionOf(order: readonly ID[], id: ID): Position {
  const index = order.indexOf(id)
  const below = index > 0 ? order[index - 1] : undefined
  return below === undefined ? "bottom" : { after: below }
}

export type PlaceResult =
  { ok: true; order: ID[] } | { ok: false; reason: "missing-anchor" | "self-anchor" }

/** `order` with `id` (re)inserted at `position`. Does not modify `order`. */
export function place(order: readonly ID[], id: ID, position: Position): PlaceResult {
  const rest = order.filter((entry) => entry !== id)
  if (position === "top") return { ok: true, order: [...rest, id] }
  if (position === "bottom") return { ok: true, order: [id, ...rest] }
  if (position.after === id) return { ok: false, reason: "self-anchor" }
  const index = rest.indexOf(position.after)
  if (index < 0) return { ok: false, reason: "missing-anchor" }
  return { ok: true, order: [...rest.slice(0, index + 1), id, ...rest.slice(index + 1)] }
}

export const sameOrder = (a: readonly ID[], b: readonly ID[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

/** A copy of `obj` without `key`. Entities are never edited in place, so removal builds a new object. */
export function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(obj).filter(([name]) => name !== key)) as Omit<T, K>
}

/** A null-prototype copy of `record` without the given keys. */
export function withoutKeys<V>(
  record: Record<string, V>,
  drop: ReadonlySet<string>,
): Record<string, V> {
  const entries = Object.entries(record).filter(([name]) => !drop.has(name))
  return Object.assign(Object.create(null) as Record<string, V>, Object.fromEntries(entries))
}
