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

export interface InputBudget {
  /** Deepest allowed nesting of objects and arrays. */
  depth: number
  nodes: number
  entries: number
}

export type BudgetBreach = "depth" | "nodes" | "entries"

/**
 * Walks the input once, iteratively, and reports the first budget it exceeds.
 * Counts every key, container and non-number value as a node: plain numbers
 * are free so large coordinate arrays are bounded by the vertex limits instead.
 * The walk stops at the first breach, so a hostile input costs at most the budget.
 */
export function findBudgetBreach(value: unknown, budget: InputBudget): BudgetBreach | null {
  let nodes = 0
  const stack: [unknown, number][] = [[value, 1]]
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number]
    if (typeof current !== "object" || current === null) continue
    if (depth > budget.depth) return "depth"
    nodes += 1
    const isArray = Array.isArray(current)
    const children: unknown[] = isArray ? current : Object.values(current)
    if (!isArray) {
      if (children.length > budget.entries) return "entries"
      nodes += children.length
    }
    for (const child of children) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1])
      else if (typeof child !== "number") nodes += 1
    }
    if (nodes > budget.nodes) return "nodes"
  }
  return null
}

/** Values in `value`, counted as findBudgetBreach counts them (plain numbers are free). Iterative. */
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
