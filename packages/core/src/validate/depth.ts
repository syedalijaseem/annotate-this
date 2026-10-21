/**
 * Nesting depth of any value, counting only objects and arrays. Iterative so a
 * hostile value cannot overflow the call stack, and it stops as soon as the
 * depth passes `limit` (which also makes cyclic input terminate).
 */
export function nestingDepth(value: unknown, limit: number): number {
  let deepest = 0
  const stack: [unknown, number][] = [[value, 1]]
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number]
    if (typeof current !== "object" || current === null) continue
    if (depth > deepest) deepest = depth
    if (deepest > limit) return deepest
    // Skip primitives: a million-element number array must not become a million stack entries.
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1])
    }
  }
  return deepest
}

const isPlainContainer = (value: object): boolean => {
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

const isJsonScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value))

/**
 * True when every value is plain JSON: strings, finite numbers, booleans, null,
 * arrays and plain objects. Unknown fields are not schema-checked, so this is
 * what keeps a BigInt, function, Date or NaN out of a document that must serialize.
 * Iterative, and it never queues primitives. Run it after the depth guard (cycles).
 */
export function isPlainJson(value: unknown): boolean {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (isJsonScalar(current)) continue
    if (typeof current !== "object" || !isPlainContainer(current as object)) return false
    for (const child of Array.isArray(current) ? current : Object.values(current as object)) {
      if (typeof child === "object" && child !== null) stack.push(child)
      else if (!isJsonScalar(child)) return false
    }
  }
  return true
}
