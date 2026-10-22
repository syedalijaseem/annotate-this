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

/** Arrays and objects whose prototype is null or some realm's Object.prototype. */
export const isPlainContainer = (value: object): boolean => {
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value) as object | null
  // Any realm's Object.prototype has a null prototype, so cross-realm plain objects pass.
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

export interface InputBudget {
  /** Deepest allowed nesting of objects and arrays. */
  depth: number
  nodes: number
  entries: number
}

/** Values in `value`, counted as the input copy (JsonCopier) counts them: plain numbers are free. Iterative. */
export function countNodes(value: unknown): number {
  let nodes = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (typeof current !== "object" || current === null) {
      if (typeof current !== "number") nodes += 1
      continue
    }
    const isArray = Array.isArray(current)
    const children: unknown[] = isArray ? current : Object.values(current)
    nodes += isArray ? 1 : 1 + children.length
    for (const child of children) {
      if (typeof child === "object" && child !== null) stack.push(child)
      else if (typeof child !== "number") nodes += 1
    }
  }
  return nodes
}

/** Beyond free-form JSON, the document's own structure nests this deep at most. */
export const STRUCTURE_DEPTH_ALLOWANCE = 32
