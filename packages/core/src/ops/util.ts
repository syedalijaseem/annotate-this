import type { ID } from "../types.js"

// Structural equality for JSON-like values. Recursion depth is bounded by the document depth limits.
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

// Deterministic id for an inverse operation (FNV-1a, 64-bit, hex): `apply` must
// stay pure, so inverses cannot draw random ids, and ids must stay unique per
// source operation for the idempotency window.
export function deriveId(sourceId: ID, index: number): ID {
  let hash = 0xcbf29ce484222325n
  for (const char of `inverse:${index}:${sourceId}`) {
    hash ^= BigInt(char.codePointAt(0) ?? 0)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `inv-${hash.toString(16).padStart(16, "0")}`
}

// A copy of `obj` without `key`. Entities are never edited in place, so removal builds a new object.
export function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(obj).filter(([name]) => name !== key)) as Omit<T, K>
}
